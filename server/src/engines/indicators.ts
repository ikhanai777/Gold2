// Pure indicator math on real candles. Outputs are aligned with the input
// array; positions without enough history are NaN (never back-filled).
import type { Candle } from '../types.js';

export function sma(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(v: number[], n: number): number[] {
  const out = new Array(v.length).fill(NaN);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) out[i] = e = v[i] * k + e * (1 - k);
  return out;
}

/** Wilder's smoothing (RMA). */
function rma(v: number[], n: number, start = 0): number[] {
  const out = new Array(v.length).fill(NaN);
  if (v.length - start < n) return out;
  let s = 0;
  for (let i = start; i < start + n; i++) s += v[i];
  let r = s / n;
  out[start + n - 1] = r;
  for (let i = start + n; i < v.length; i++) out[i] = r = (r * (n - 1) + v[i]) / n;
  return out;
}

export function rsi(close: number[], n = 14): number[] {
  const up = [0], dn = [0];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    up.push(Math.max(d, 0));
    dn.push(Math.max(-d, 0));
  }
  const au = rma(up, n, 1), ad = rma(dn, n, 1);
  return au.map((u, i) => (Number.isNaN(u) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
}

export function macd(close: number[], f = 12, s = 26, sig = 9) {
  const ef = ema(close, f), es = ema(close, s);
  const line = close.map((_, i) => ef[i] - es[i]);
  const firstValid = line.findIndex((x) => !Number.isNaN(x));
  const signal = new Array(close.length).fill(NaN);
  if (firstValid >= 0) {
    const e = ema(line.slice(firstValid), sig);
    e.forEach((x, i) => (signal[firstValid + i] = x));
  }
  const hist = line.map((x, i) => x - signal[i]);
  return { line, signal, hist };
}

export function trueRange(c: Candle[]): number[] {
  return c.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close))));
}

export function atr(c: Candle[], n = 14): number[] {
  return rma(trueRange(c), n);
}

export function adx(c: Candle[], n = 14): number[] {
  const pdm = [0], mdm = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = rma(trueRange(c), n, 1), p = rma(pdm, n, 1), m = rma(mdm, n, 1);
  const dx = c.map((_, i) => {
    const pdi = (100 * p[i]) / tr[i], mdi = (100 * m[i]) / tr[i];
    return Number.isNaN(pdi) || pdi + mdi === 0 ? NaN : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  });
  const first = dx.findIndex((x) => !Number.isNaN(x));
  const out = new Array(c.length).fill(NaN);
  if (first >= 0) rma(dx.slice(first), n).forEach((x, i) => (out[first + i] = x));
  return out;
}

export function bollinger(close: number[], n = 20, k = 2) {
  const mid = sma(close, n);
  const upper: number[] = [], lower: number[] = [], width: number[] = [];
  for (let i = 0; i < close.length; i++) {
    if (Number.isNaN(mid[i])) {
      upper.push(NaN); lower.push(NaN); width.push(NaN);
      continue;
    }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (close[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper.push(mid[i] + k * sd);
    lower.push(mid[i] - k * sd);
    width.push((2 * k * sd) / mid[i]);
  }
  return { mid, upper, lower, width };
}

/** Session VWAP, reset at each UTC-day boundary shifted to the 22:00 UTC gold session open. */
export function sessionVwap(c: Candle[]): number[] {
  let pv = 0, vv = 0, session = -1;
  return c.map((b) => {
    const s = Math.floor((b.time + 2 * 3600) / 86400);
    if (s !== session) { session = s; pv = 0; vv = 0; }
    if (b.volume == null || b.volume <= 0) return vv > 0 ? pv / vv : NaN;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vv += b.volume;
    return pv / vv;
  });
}

export type PivotMethod = 'classic' | 'fibonacci' | 'camarilla';
export function pivots(prev: Candle, method: PivotMethod = 'classic'): Record<string, number> {
  const { high: H, low: L, close: C } = prev;
  const P = (H + L + C) / 3, R = H - L;
  if (method === 'fibonacci')
    return { P, R1: P + 0.382 * R, R2: P + 0.618 * R, R3: P + R, S1: P - 0.382 * R, S2: P - 0.618 * R, S3: P - R };
  if (method === 'camarilla')
    return { P, R1: C + (R * 1.1) / 12, R2: C + (R * 1.1) / 6, R3: C + (R * 1.1) / 4, R4: C + (R * 1.1) / 2,
      S1: C - (R * 1.1) / 12, S2: C - (R * 1.1) / 6, S3: C - (R * 1.1) / 4, S4: C - (R * 1.1) / 2 };
  return { P, R1: 2 * P - L, R2: P + R, R3: H + 2 * (P - L), S1: 2 * P - H, S2: P - R, S3: L - 2 * (H - P) };
}

/** Pearson correlation of daily % changes over the last n aligned points. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return NaN;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function pctChanges(v: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < v.length; i++) out.push(v[i - 1] ? v[i] / v[i - 1] - 1 : 0);
  return out;
}

/** z-score of the latest `lag`-period change relative to the history of such changes. */
export function changeZ(v: number[], lag: number, lookback = 252): number {
  if (v.length < lag + 30) return NaN;
  const ch: number[] = [];
  for (let i = Math.max(lag, v.length - lookback); i < v.length; i++) ch.push(v[i] - v[i - lag]);
  const last = ch[ch.length - 1];
  const m = ch.reduce((a, b) => a + b, 0) / ch.length;
  const sd = Math.sqrt(ch.reduce((a, b) => a + (b - m) ** 2, 0) / ch.length);
  return sd > 0 ? (last - m) / sd : 0;
}

export function percentileRank(hist: number[], x: number): number {
  if (!hist.length) return NaN;
  return hist.filter((h) => h <= x).length / hist.length;
}

export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const last = <T>(a: T[]): T | undefined => a[a.length - 1];
export const lastValid = (a: number[]): number => {
  for (let i = a.length - 1; i >= 0; i--) if (!Number.isNaN(a[i])) return a[i];
  return NaN;
};
