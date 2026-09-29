// Aggregate real lower-timeframe bars into higher timeframes (SPEC §1.4:
// aggregation of real data is allowed; gaps stay gaps — empty buckets are
// simply absent, never synthesised).
import type { Candle } from '../types.js';

export function aggregate(bars: Candle[], bucketSec: number, offsetSec = 0): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const b of bars) {
    const t = Math.floor((b.time - offsetSec) / bucketSec) * bucketSec + offsetSec;
    if (!cur || cur.time !== t) {
      if (cur) out.push(cur);
      cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      if (b.volume != null) cur.volume = (cur.volume ?? 0) + b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Weekly bars starting Monday 00:00 UTC. 1970-01-01 was a Thursday → offset 4 days. */
export const toWeekly = (daily: Candle[]) => aggregate(daily, 7 * 86400, 4 * 86400);

/** Monthly bars keyed on the first day of each UTC month. */
export function toMonthly(daily: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null, key = '';
  for (const b of daily) {
    const d = new Date(b.time * 1000);
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { time: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000, open: b.open, high: b.high, low: b.low, close: b.close };
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Merge candle arrays by time; later arrays win on conflicts. */
export function mergeCandles(...arrs: Candle[][]): Candle[] {
  const m = new Map<number, Candle>();
  for (const a of arrs) for (const c of a) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
