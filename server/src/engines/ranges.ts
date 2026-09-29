// Projected day / week / month ranges (SPEC §5.4, §6.2).
// σ blends GVZ implied volatility with a walk-forward-calibrated ATR multiple.
// Hit rates are out-of-sample: each historical period uses only a k fitted on
// periods that ended before it, and GVZ/ATR known at the prior close.
import type { Candle, SeriesPoint } from '../types.js';
import { atr, clamp } from './indicators.js';
import { toMonthly, toWeekly } from './aggregate.js';
import type { Zone } from './levels.js';

export type Period = 'day' | 'week' | 'month';
export const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 5, month: 21 };

export interface RangeBand {
  period: Period;
  periodStart: number; // unix sec (first bar of the current period)
  open: number;
  mid: number;
  sigma: number;
  low: number;
  high: number;
  extLow: number;
  extHigh: number;
  method: string;
  inputs: string[];
  hitRate68: number | null; // share of past periods whose close stayed inside ±1σ
  hitRate95: number | null;
  samples: number;
  k: number | null;
  snapped: string[];
  realizedHigh: number;
  realizedLow: number;
}

const IV_WEIGHT = 0.6;
const MIN_TRAIN = 60;

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function insertSorted(arr: number[], x: number) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1; else hi = m;
  }
  arr.splice(lo, 0, x);
}

function periodBars(daily: Candle[], p: Period) {
  return p === 'day' ? daily : p === 'week' ? toWeekly(daily) : toMonthly(daily);
}

/** Look up the latest series value strictly before `timeSec`. */
function valueBefore(series: SeriesPoint[], timeSec: number): number | null {
  const d = new Date(timeSec * 1000).toISOString().slice(0, 10);
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (series[m].date < d) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans >= 0 ? series[ans].value : null;
}

export function projectRanges(daily: Candle[], gvz: SeriesPoint[], score: Record<Period, number>, zones: Zone[]): RangeBand[] {
  if (daily.length < 120) return [];
  const dAtr = atr(daily, 14);
  const dayIndex = new Map(daily.map((c, i) => [c.time, i]));
  const out: RangeBand[] = [];

  for (const p of ['day', 'week', 'month'] as Period[]) {
    const bars = periodBars(daily, p);
    const d = PERIOD_DAYS[p];
    // Index of the last daily bar before each period's start → ATR/GVZ known at that time.
    const priorDailyIdx = (t: number) => {
      let lo = 0, hi = daily.length - 1, ans = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (daily[m].time < t) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return ans;
    };

    // Walk-forward: ratios |close-open| / (ATR·√d) of completed periods.
    const trainRatios: number[] = [];
    let hits68 = 0, hits95 = 0, n = 0;
    for (let i = 0; i < bars.length - 1; i++) {
      const b = bars[i];
      const j = priorDailyIdx(b.time);
      if (j < 20 || !Number.isFinite(dAtr[j])) continue;
      const atrScale = dAtr[j] * Math.sqrt(d);
      if (trainRatios.length >= MIN_TRAIN) {
        const k = quantile(trainRatios, 0.6827);
        const g = valueBefore(gvz, b.time);
        const sAtr = k * atrScale;
        const sigma = g != null ? IV_WEIGHT * b.open * (g / 100) * Math.sqrt(d / 252) + (1 - IV_WEIGHT) * sAtr : sAtr;
        const dev = Math.abs(b.close - b.open);
        if (dev <= sigma) hits68++;
        if (dev <= 2 * sigma) hits95++;
        n++;
      }
      insertSorted(trainRatios, Math.abs(b.close - b.open) / atrScale);
    }

    const cur = bars[bars.length - 1];
    const j = priorDailyIdx(cur.time);
    const jj = j >= 0 ? j : dayIndex.get(cur.time) ?? daily.length - 1;
    const atrScale = dAtr[jj] * Math.sqrt(d);
    const k = trainRatios.length >= MIN_TRAIN ? quantile(trainRatios, 0.6827) : null;
    const g = valueBefore(gvz, cur.time);
    const sAtr = (k ?? 1) * atrScale;
    const sIv = g != null ? cur.open * (g / 100) * Math.sqrt(d / 252) : null;
    const sigma = sIv != null ? IV_WEIGHT * sIv + (1 - IV_WEIGHT) * sAtr : sAtr;
    const skew = clamp((score[p] ?? 0) / 100, -1, 1) * 0.25 * sigma;
    const mid = cur.open + skew;
    let low = mid - sigma, high = mid + sigma;
    const snapped: string[] = [];
    for (const z of zones) {
      if (z.strength < 7) continue;
      if (Math.abs(z.price - low) <= 0.2 * sigma) { snapped.push(`low→${z.label}`); low = z.price; }
      if (Math.abs(z.price - high) <= 0.2 * sigma) { snapped.push(`high→${z.label}`); high = z.price; }
    }
    const inputs = [
      `period open ${cur.open.toFixed(2)}`,
      `ATR(14, daily) ${dAtr[jj]?.toFixed(2)} × √${d} × k ${k?.toFixed(2) ?? 'n/a (insufficient history)'}`,
      sIv != null ? `GVZ ${g!.toFixed(2)} (prior close) → σ_IV ${sIv.toFixed(2)}` : 'GVZ unavailable → ATR only',
      `skew ${skew.toFixed(2)} from ${p} signal score ${Math.round(score[p] ?? 0)}`,
    ];
    out.push({
      period: p, periodStart: cur.time, open: cur.open, mid, sigma, low, high,
      extLow: mid - 2 * sigma, extHigh: mid + 2 * sigma,
      method: sIv != null ? `${IV_WEIGHT * 100}% GVZ implied vol + ${(1 - IV_WEIGHT) * 100}% calibrated ATR` : 'Calibrated ATR (GVZ unavailable)',
      inputs,
      hitRate68: n ? hits68 / n : null, hitRate95: n ? hits95 / n : null, samples: n, k, snapped,
      realizedHigh: cur.high, realizedLow: cur.low,
    });
  }
  return out;
}
