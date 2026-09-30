// In-app engine for the Android build: the same data providers and analytics
// as the Node server, running inside the app. Native HTTP (CapacitorHttp)
// fetches the free sources directly, so no PC or server is needed.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { applySettings } from '../../server/src/config';
import { memoryStore, setStore } from '../../server/src/store';
import { setTransport, type Transport } from '../../server/src/transport';
import { onEvent, startJobs } from '../../server/src/jobs';
import {
  analysisInstrument, availableInstruments, candlesPayload, computePerformance, computeRanges, computeSignals,
  factorsPayload, levelsPayload, performancePayload, quotePayload, rangesPayload, signalsPayload, statusPayload,
} from '../../server/src/analytics';
import { INSTRUMENTS, state, type InstrumentId } from '../../server/src/state';
import type { Timeframe } from '../../server/src/types';
import type { LocalBackend } from '../../web/src/api';

export const SETTINGS_KEY = 'gsd:settings';
export interface AppSettings { TWELVEDATA_API_KEY?: string; FRED_API_KEY?: string; FINNHUB_API_KEY?: string }

export function loadSettings(): AppSettings {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as AppSettings; } catch { return {}; }
}
export function saveSettings(s: AppSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Native HTTP: not subject to browser CORS, so every free source is reachable from the phone. */
const nativeTransport: Transport = async (url, { headers, timeoutMs }) => {
  const res = await CapacitorHttp.request({
    url, method: 'GET', headers, responseType: 'arraybuffer', connectTimeout: timeoutMs, readTimeout: timeoutMs,
  });
  const ok = res.status >= 200 && res.status < 300;
  const data: unknown = res.data;
  let text: string | null = null;
  let bytes: Uint8Array | null = null;
  if (typeof data !== 'string') text = JSON.stringify(data ?? null); // JSON bodies are parsed natively
  else if (ok) bytes = base64ToBytes(data); // other successful bodies arrive base64-encoded
  else text = data; // error bodies arrive as plain text
  return {
    status: res.status,
    text: async () => text ?? new TextDecoder('utf-8').decode(bytes!),
    bytes: async () => bytes ?? new TextEncoder().encode(text!),
  };
};

const TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const pickInst = (q: URLSearchParams): InstrumentId | null => {
  const i = q.get('instrument') as InstrumentId | null;
  if (i && i in INSTRUMENTS) return i;
  return analysisInstrument() ?? availableInstruments()[0] ?? null;
};
const pickTf = (q: URLSearchParams): Timeframe => (TFS.includes(q.get('tf') as Timeframe) ? (q.get('tf') as Timeframe) : '1h');

class NotReady extends Error {}

let lastPerf = 0;
/** Same routes as the Node server's /api, answered in-process. */
async function route(path: string): Promise<unknown> {
  const [name, qs = ''] = path.split('?');
  const q = new URLSearchParams(qs);
  switch (name) {
    case 'status': return statusPayload();
    case 'quote': return quotePayload();
    case 'factors': return { factors: factorsPayload() };
    case 'signals': return signalsPayload();
    case 'ranges': return rangesPayload();
    case 'candles': {
      const inst = pickInst(q);
      const p = inst && candlesPayload(inst, pickTf(q), Math.min(5000, Number(q.get('limit')) || 1500));
      if (!p) throw new NotReady('Loading real candles…');
      return p;
    }
    case 'levels': {
      const inst = pickInst(q);
      if (!inst) throw new NotReady('No instrument loaded yet');
      return levelsPayload(inst, pickTf(q));
    }
    case 'news': {
      const min = Number(q.get('minImpact')) || 0;
      const topic = q.get('topic');
      return { items: state.news.filter((n) => (!topic || n.topic === topic) && n.impact >= min).slice(0, 200), feeds: Object.fromEntries(state.newsFetchedAt), computedTags: true };
    }
    case 'calendar': {
      const days = Math.min(14, Number(q.get('days')) || 7);
      const from = Date.now() - 12 * 3600e3, to = Date.now() + days * 86400e3;
      return { source: state.calendarSource, fetchedAt: state.calendarFetchedAt, events: state.calendar.filter((e) => Date.parse(e.ts) >= from && Date.parse(e.ts) <= to) };
    }
    case 'performance': {
      // Backtests are CPU-heavy on a phone, so they run only when the Performance page asks.
      if (!performancePayload().backtests.length || Date.now() - lastPerf > 12 * 3600e3) {
        await new Promise((r) => setTimeout(r, 60)); // let the page paint its loading state first
        try { computePerformance(); } catch (e) { console.error('[performance]', e); }
        if (performancePayload().backtests.length) lastPerf = Date.now();
      }
      return performancePayload();
    }
    default: throw new Error(`Unknown request: ${name}`);
  }
}

export function startEngine(): LocalBackend {
  applySettings(loadSettings() as Record<string, string | undefined>);
  setStore(memoryStore({
    get: (k) => { try { return localStorage.getItem(`gsd:store:${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`gsd:store:${k}`, v); } catch { /* full */ } },
  }));
  if (Capacitor.isNativePlatform()) setTransport(nativeTransport);
  // In a desktop browser the default fetch transport is used (sources without CORS headers will fail there).
  startJobs(() => { computeSignals(); computeRanges(); });
  onEvent((ev) => { if (ev === 'candles') computeSignals(); });
  // Serialise like the HTTP API does (NaN → null, no shared references into engine state).
  return { request: async (path) => JSON.parse(JSON.stringify(await route(path))), subscribe: onEvent };
}
