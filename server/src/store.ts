// Persistence interface used by the engine. The Node server injects a SQLite
// store (node/sqliteStore.ts); the Android app injects memoryStore with
// localStorage persistence for the small logs.
import type { Candle } from './types.js';

export interface SignalRow { ts: string; horizon: string; score: number; label: string; confidence: string; price: number; instrument: string }
export interface RangeRow { period: string; periodStart: string; instrument: string; open: number; low: number; high: number; extLow: number; extHigh: number; publishedAt: string }
export interface NewsRow { id: string; ts: string; title: string; url: string; source: string; feed: string; snippet: string; topic: string; direction: number; impact: number; rationale: string }

export interface Store {
  usageGet(provider: string, day: string): number;
  usageBump(provider: string, day: string): void;
  saveCandles(instrument: string, tf: string, candles: Candle[], source: string): void;
  loadCandles(instrument: string, tf: string, sinceSec: number): Candle[];
  insertNews(item: NewsRow): void;
  logSignal(row: SignalRow): void;
  lastSignalLabel(horizon: string): string | null;
  signalHistory(horizon: string, sinceIso: string): { ts: string; label: string; score: number }[];
  recentSignals(limit: number): SignalRow[];
  /** Insert if (period, periodStart, instrument) is new; published bands never change. */
  logRange(row: RangeRow): void;
  recentRanges(limit: number): RangeRow[];
}

export interface KeyValue { get(key: string): string | null; set(key: string, value: string): void }

/** In-memory store. With `kv`, usage counters and signal/range logs survive restarts. */
export function memoryStore(kv?: KeyValue): Store {
  const load = <T>(k: string, d: T): T => {
    try { const v = kv?.get(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
  };
  const save = (k: string, v: unknown) => { try { kv?.set(k, JSON.stringify(v)); } catch { /* storage full or unavailable */ } };
  let usage = load<Record<string, number>>('usage', {});
  const signals = load<SignalRow[]>('signals', []);
  const ranges = load<RangeRow[]>('ranges', []);
  const candles = new Map<string, Map<number, Candle>>();
  const today = new Date().toISOString().slice(0, 10);
  usage = Object.fromEntries(Object.entries(usage).filter(([k]) => k.endsWith(today)));
  return {
    usageGet: (p, d) => usage[`${p}|${d}`] ?? 0,
    usageBump: (p, d) => { usage[`${p}|${d}`] = (usage[`${p}|${d}`] ?? 0) + 1; save('usage', usage); },
    saveCandles: (inst, tf, cs) => {
      const k = `${inst}:${tf}`;
      const m = candles.get(k) ?? candles.set(k, new Map()).get(k)!;
      for (const c of cs) m.set(c.time, c);
    },
    loadCandles: (inst, tf, since) => [...(candles.get(`${inst}:${tf}`)?.values() ?? [])].filter((c) => c.time >= since).sort((a, b) => a.time - b.time),
    insertNews: () => { /* the live feed is held in state; nothing to persist on device */ },
    logSignal: (row) => {
      const i = signals.findIndex((s) => s.ts === row.ts && s.horizon === row.horizon);
      if (i >= 0) signals[i] = row; else signals.push(row);
      if (signals.length > 3000) signals.splice(0, signals.length - 3000);
      save('signals', signals);
    },
    lastSignalLabel: (h) => { for (let i = signals.length - 1; i >= 0; i--) if (signals[i].horizon === h) return signals[i].label; return null; },
    signalHistory: (h, since) => signals.filter((s) => s.horizon === h && s.ts >= since).map(({ ts, label, score }) => ({ ts, label, score })),
    recentSignals: (n) => signals.slice(-n).reverse(),
    logRange: (row) => {
      if (ranges.some((r) => r.period === row.period && r.periodStart === row.periodStart && r.instrument === row.instrument)) return;
      ranges.push(row);
      if (ranges.length > 600) ranges.splice(0, ranges.length - 600);
      save('ranges', ranges);
    },
    recentRanges: (n) => ranges.slice().sort((a, b) => b.periodStart.localeCompare(a.periodStart)).slice(0, n),
  };
}

let impl: Store = memoryStore();
export const setStore = (s: Store) => { impl = s; };
export const store = () => impl;
