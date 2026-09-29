// Support / resistance zone detection (SPEC §6.1): fractal swing points →
// ATR-scaled clustering → strength scoring → multi-timeframe confluence.
import type { Candle } from '../types.js';
import { atr, lastValid } from './indicators.js';

export interface Zone {
  price: number; // zone centre
  low: number;
  high: number;
  strength: number; // 0–10
  touches: number;
  kind: 'support' | 'resistance';
  label: string; // S1..S3 / R1..R3
  lastTouch: number; // unix sec
  confluence: boolean;
}

interface Swing { price: number; time: number; idx: number; type: 'H' | 'L'; wick: number }

function swings(c: Candle[], n: number): Swing[] {
  const out: Swing[] = [];
  for (let i = n; i < c.length - n; i++) {
    let isH = true, isL = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isH = false;
      if (c[j].low <= c[i].low) isL = false;
    }
    const body = Math.abs(c[i].close - c[i].open) || 1e-9;
    if (isH) out.push({ price: c[i].high, time: c[i].time, idx: i, type: 'H', wick: (c[i].high - Math.max(c[i].open, c[i].close)) / body });
    if (isL) out.push({ price: c[i].low, time: c[i].time, idx: i, type: 'L', wick: (Math.min(c[i].open, c[i].close) - c[i].low) / body });
  }
  return out;
}

interface Cluster { prices: number[]; times: number[]; idxs: number[]; wicks: number[] }

function roundNumberStep(price: number) {
  return price > 1000 ? 50 : price > 100 ? 5 : 1;
}

export function detectZones(c: Candle[], opts: { fractal?: number; lookback?: number; perSide?: number; higherTf?: Candle[] } = {}): Zone[] {
  const lookback = opts.lookback ?? 400;
  const bars = c.slice(-lookback);
  if (bars.length < 30) return [];
  const a = lastValid(atr(bars, 14));
  if (!Number.isFinite(a) || a <= 0) return [];
  const sw = swings(bars, opts.fractal ?? 5).sort((x, y) => x.price - y.price);

  // Greedy 1-D clustering: consecutive swing prices within 0.25·ATR merge.
  const clusters: Cluster[] = [];
  for (const s of sw) {
    const cl = clusters[clusters.length - 1];
    const centre = cl ? cl.prices.reduce((p, q) => p + q, 0) / cl.prices.length : 0;
    if (cl && Math.abs(s.price - centre) <= 0.25 * a) {
      cl.prices.push(s.price); cl.times.push(s.time); cl.idxs.push(s.idx); cl.wicks.push(s.wick);
    } else clusters.push({ prices: [s.price], times: [s.time], idxs: [s.idx], wicks: [s.wick] });
  }

  const htfZones = opts.higherTf ? detectZones(opts.higherTf, { fractal: 3, lookback: 300, perSide: 5 }) : [];
  const price = bars[bars.length - 1].close;
  const step = roundNumberStep(price);

  const zones = clusters.map((cl) => {
    const centre = cl.prices.reduce((p, q) => p + q, 0) / cl.prices.length;
    const touches = cl.prices.length;
    const recency = Math.max(...cl.idxs) / bars.length; // 0..1
    const wickBonus = Math.min(1.5, cl.wicks.reduce((p, q) => p + Math.min(q, 3), 0) / touches / 2);
    const roundBonus = Math.abs(centre - Math.round(centre / step) * step) <= 0.15 * a ? 1 : 0;
    let raw = touches * 2 + recency * 2 + wickBonus + roundBonus;
    const confluence = htfZones.some((z) => Math.abs(z.price - centre) <= 0.5 * a + (z.high - z.low) / 2);
    if (confluence) raw *= 1.5;
    return {
      price: centre,
      low: Math.min(...cl.prices) - 0.1 * a,
      high: Math.max(...cl.prices) + 0.1 * a,
      raw,
      touches,
      lastTouch: Math.max(...cl.times),
      confluence,
    };
  });

  const maxRaw = Math.max(1, ...zones.map((z) => z.raw));
  const perSide = opts.perSide ?? 3;
  const above = zones.filter((z) => z.price > price).sort((x, y) => x.price - y.price);
  const below = zones.filter((z) => z.price <= price).sort((x, y) => y.price - x.price);
  // Keep the strongest zones per side, then label by distance from price.
  // Prefer the strongest zones within 6·ATR of price (actionable); fill with the nearest others.
  const pick = (arr: typeof zones) => {
    const near = arr.filter((z) => Math.abs(z.price - price) <= 6 * a).sort((x, y) => y.raw - x.raw).slice(0, perSide);
    const rest = arr.filter((z) => !near.includes(z)).slice(0, perSide - near.length); // arr is sorted by distance
    return [...near, ...rest].sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price));
  };
  const toZone = (z: (typeof zones)[number], kind: Zone['kind'], i: number): Zone => ({
    price: z.price, low: z.low, high: z.high, touches: z.touches, lastTouch: z.lastTouch, confluence: z.confluence,
    strength: Math.round((10 * z.raw) / maxRaw * 10) / 10,
    kind, label: `${kind === 'support' ? 'S' : 'R'}${i + 1}`,
  });
  return [...pick(above).map((z, i) => toZone(z, 'resistance', i)), ...pick(below).map((z, i) => toZone(z, 'support', i))];
}

/** Auto-anchored Fibonacci retracement of the most significant swing in the window. */
export function fibRetracement(c: Candle[], lookback = 150) {
  const bars = c.slice(-lookback);
  if (bars.length < 10) return null;
  let hi = bars[0], lo = bars[0];
  for (const b of bars) {
    if (b.high > hi.high) hi = b;
    if (b.low < lo.low) lo = b;
  }
  const up = lo.time < hi.time; // swing low → high = up-leg; retrace downward
  const range = hi.high - lo.low;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  return {
    from: up ? { time: lo.time, price: lo.low } : { time: hi.time, price: hi.high },
    to: up ? { time: hi.time, price: hi.high } : { time: lo.time, price: lo.low },
    levels: ratios.map((r) => ({ ratio: r, price: up ? hi.high - r * range : lo.low + r * range })),
  };
}
