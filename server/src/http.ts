// Shared HTTP layer: proxy support, timeouts, per-provider daily caps and
// health tracking. Every outbound call goes through here.
import { config } from './config.js';
import { store } from './store.js';
import { transport, type TransportResponse } from './transport.js';

const UA = 'Mozilla/5.0 (GoldSignalDashboard; personal non-commercial use)';

export interface ProviderHealth {
  provider: string;
  lastOk: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  callsToday: number;
  cap: number;
  backoffUntil: number;
}

const health = new Map<string, ProviderHealth>();
const today = () => new Date().toISOString().slice(0, 10);

/** Sub-providers such as "rss:bbc" share their family's per-source cap ("rss"). */
const capFor = (provider: string) => config.dailyCaps[provider] ?? config.dailyCaps[provider.split(':')[0]] ?? 1000;

function h(provider: string): ProviderHealth {
  let x = health.get(provider);
  if (!x) {
    x = { provider, lastOk: null, lastError: null, lastErrorAt: null, callsToday: 0, cap: capFor(provider), backoffUntil: 0 };
    health.set(provider, x);
  }
  x.cap = capFor(provider);
  x.callsToday = store().usageGet(provider, today());
  return x;
}

export function providerHealth(): ProviderHealth[] {
  // Every configured provider plus sub-providers seen at runtime (e.g. each RSS feed).
  const ids = new Set([...Object.keys(config.dailyCaps).filter((p) => p !== 'rss'), ...health.keys()]);
  return [...ids].sort().map((p) => h(p));
}

export class ProviderError extends Error {
  constructor(public provider: string, message: string, public status?: number) {
    super(`[${provider}] ${message}`);
  }
}

// Serialise calls per provider when a minimum spacing is required (e.g. GDELT: 1 per 5 s).
const lastCallAt = new Map<string, number>();
const MIN_SPACING_MS: Record<string, number> = { gdelt: 6000, twelvedata: 8000 };

export async function request(
  provider: string,
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<TransportResponse> {
  const st = h(provider);
  if (Date.now() < st.backoffUntil) throw new ProviderError(provider, 'in backoff after rate limit');
  if (st.callsToday >= st.cap) throw new ProviderError(provider, `daily cap ${st.cap} reached (free-tier guardrail)`);

  const spacing = MIN_SPACING_MS[provider];
  if (spacing) {
    const wait = (lastCallAt.get(provider) ?? 0) + spacing - Date.now();
    lastCallAt.set(provider, Math.max(Date.now(), (lastCallAt.get(provider) ?? 0) + spacing));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  store().usageBump(provider, today());
  st.callsToday++;
  try {
    const res = await transport()(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...opts.headers },
      timeoutMs: opts.timeoutMs ?? 20000,
    });
    if (res.status === 429 || res.status === 403) {
      st.backoffUntil = Date.now() + (res.status === 429 ? 60_000 : 5 * 60_000);
      throw new ProviderError(provider, `HTTP ${res.status}`, res.status);
    }
    if (res.status < 200 || res.status >= 300) throw new ProviderError(provider, `HTTP ${res.status}`, res.status);
    return res;
  } catch (e) {
    st.lastError = e instanceof Error ? e.message : String(e);
    st.lastErrorAt = new Date().toISOString();
    throw e instanceof ProviderError ? e : new ProviderError(provider, st.lastError);
  }
}

export function markOk(provider: string) {
  h(provider).lastOk = new Date().toISOString();
}

export async function getJson<T = any>(provider: string, url: string, opts?: Parameters<typeof request>[2]): Promise<T> {
  const res = await request(provider, url, opts);
  const text = await res.text();
  try {
    const j = JSON.parse(text) as T;
    markOk(provider);
    return j;
  } catch {
    throw new ProviderError(provider, `invalid JSON: ${text.slice(0, 120)}`);
  }
}

export async function getText(provider: string, url: string, opts?: Parameters<typeof request>[2]): Promise<string> {
  const res = await request(provider, url, opts);
  const t = await res.text();
  markOk(provider);
  return t;
}

export async function getBuffer(provider: string, url: string, opts?: Parameters<typeof request>[2]): Promise<Uint8Array> {
  const res = await request(provider, url, { timeoutMs: 60000, ...opts });
  const b = await res.bytes();
  markOk(provider);
  return b;
}
