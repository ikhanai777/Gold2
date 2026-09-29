// Shared HTTP layer: proxy support, timeouts, per-provider daily caps and
// health tracking. Every outbound call goes through here.
import { fetch, EnvHttpProxyAgent, setGlobalDispatcher, type Response } from 'undici';
import { config } from './config.js';
import { db } from './db.js';

if (process.env.HTTPS_PROXY || process.env.https_proxy) setGlobalDispatcher(new EnvHttpProxyAgent());

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
const getUsage = db.prepare('SELECT count FROM usage WHERE provider=? AND day=?');
const bumpUsage = db.prepare(
  'INSERT INTO usage (provider, day, count) VALUES (?, ?, 1) ON CONFLICT(provider, day) DO UPDATE SET count = count + 1',
);

function h(provider: string): ProviderHealth {
  let x = health.get(provider);
  if (!x) {
    x = { provider, lastOk: null, lastError: null, lastErrorAt: null, callsToday: 0, cap: config.dailyCaps[provider] ?? 1000, backoffUntil: 0 };
    health.set(provider, x);
  }
  const row = getUsage.get(provider, today()) as { count: number } | undefined;
  x.callsToday = row?.count ?? 0;
  return x;
}

export function providerHealth(): ProviderHealth[] {
  return Object.keys(config.dailyCaps).map((p) => h(p));
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
): Promise<Response> {
  const st = h(provider);
  if (Date.now() < st.backoffUntil) throw new ProviderError(provider, 'in backoff after rate limit');
  if (st.callsToday >= st.cap) throw new ProviderError(provider, `daily cap ${st.cap} reached (free-tier guardrail)`);

  const spacing = MIN_SPACING_MS[provider];
  if (spacing) {
    const wait = (lastCallAt.get(provider) ?? 0) + spacing - Date.now();
    lastCallAt.set(provider, Math.max(Date.now(), (lastCallAt.get(provider) ?? 0) + spacing));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  bumpUsage.run(provider, today());
  st.callsToday++;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      redirect: 'follow',
    });
    if (res.status === 429 || res.status === 403) {
      st.backoffUntil = Date.now() + (res.status === 429 ? 60_000 : 5 * 60_000);
      throw new ProviderError(provider, `HTTP ${res.status}`, res.status);
    }
    if (!res.ok) throw new ProviderError(provider, `HTTP ${res.status}`, res.status);
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

export async function getBuffer(provider: string, url: string, opts?: Parameters<typeof request>[2]): Promise<Buffer> {
  const res = await request(provider, url, { timeoutMs: 60000, ...opts });
  const b = Buffer.from(await res.arrayBuffer());
  markOk(provider);
  return b;
}
