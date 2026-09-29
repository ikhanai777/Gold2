// Walk-forward backtest of the scoring model on real history (SPEC §5.8).
// At every evaluation point only data available at that time is used:
// candles ≤ t (fractal swings confirm with lag), macro series strictly before
// the cutoff date, COT only after its Friday publication.
import type { Candle, SeriesPoint } from '../types.js';
import { detectZones } from './levels.js';
import {
  combine, cotScore, geoScore, momentumScore, precompute, seasonalityScore, seriesScore, srScore, trendScore,
  type FactorScore, type Horizon, type Label,
} from './scoring.js';

export interface MacroHistory {
  real10?: SeriesPoint[]; nom2?: SeriesPoint[]; breakeven?: SeriesPoint[]; dxy?: SeriesPoint[]; vix?: SeriesPoint[];
  gpr?: SeriesPoint[]; gld?: SeriesPoint[]; cot?: { date: string; net: number }[];
}

export const LAG: Record<Horizon, number> = { intraday: 1, swing: 5, position: 20 };

function upTo<T extends { date: string }>(s: T[] | undefined, cutoff: string): T[] | undefined {
  if (!s) return undefined;
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (s[m].date < cutoff) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return s.slice(Math.max(0, ans - 400), ans + 1);
}

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

export function macroScores(h: Horizon, m: MacroHistory, cutoff: string): FactorScore[] {
  const lag = LAG[h];
  const cotAvail = m.cot?.filter((c) => addDays(c.date, 3) < cutoff).map((c) => c.net) ?? [];
  return [
    seriesScore('realYields', upTo(m.real10, cutoff), lag, -1, '%'),
    seriesScore('fedExp', upTo(m.nom2, cutoff), lag, -1, '%'),
    seriesScore('breakevens', upTo(m.breakeven, cutoff), lag, 1, '%'),
    seriesScore('dxy', upTo(m.dxy, cutoff), lag, -1),
    seriesScore('vix', upTo(m.vix, cutoff), lag, 1),
    seriesScore('etf', upTo(m.gld, cutoff), lag, 1, 't'),
    geoScore(upTo(m.gpr, cutoff)),
    cotScore(cotAvail),
  ];
}

export interface BacktestResult {
  horizon: Horizon;
  bars: string;
  forward: string;
  from: string;
  to: string;
  samples: number;
  factorsUsed: string[];
  byLabel: { label: Label; count: number; avgFwdReturn: number; hitRate: number | null }[];
  directionalHitRate: number | null;
  strategy: { totalReturn: number; maxDrawdown: number; exposure: number };
  buyHold: { totalReturn: number; maxDrawdown: number };
  equity: { time: number; strategy: number; buyHold: number }[];
}

export function runBacktest(opts: {
  horizon: Horizon; bars: Candle[]; fwd: number; barLabel: string; fwdLabel: string;
  macro: MacroHistory; cutoffFor: (bar: Candle) => string; daily?: Candle[]; warmup?: number; maxEval?: number;
}): BacktestResult | null {
  const { horizon, bars, fwd, macro } = opts;
  const warmup = opts.warmup ?? 220;
  if (bars.length < warmup + fwd + 30) return null;
  const pre = precompute(bars);
  const start = Math.max(warmup, bars.length - fwd - (opts.maxEval ?? 2500));
  const labels: (Label | null)[] = new Array(bars.length).fill(null);
  let prev: Label | null = null;
  const used = new Set<string>();

  for (let t = start; t < bars.length; t++) {
    const zones = detectZones(bars.slice(Math.max(0, t - 300), t + 1), { lookback: 300 });
    const f: FactorScore[] = [trendScore(pre, t), momentumScore(pre, t), srScore(bars, zones, pre.atr[t], t), ...macroScores(horizon, macro, opts.cutoffFor(bars[t]))];
    if (horizon === 'position' && opts.daily) {
      const di = opts.daily.findLastIndex((d) => d.time <= bars[t].time + 4 * 86400);
      if (di > 0) f.push(seasonalityScore(opts.daily, di));
    }
    const r = combine(horizon, f, { prevLabel: prev });
    r.contributions.forEach((c) => used.add(c.name));
    labels[t] = prev = r.label;
  }

  const groups = new Map<Label, number[]>();
  let hits = 0, dirN = 0;
  for (let t = start; t < bars.length - fwd; t++) {
    const L = labels[t]!;
    const ret = bars[t + fwd].close / bars[t].close - 1;
    (groups.get(L) ?? groups.set(L, []).get(L)!).push(ret);
    const dir = L.includes('BUY') ? 1 : L.includes('SELL') ? -1 : 0;
    if (dir) { dirN++; if (Math.sign(ret) === dir) hits++; }
  }

  // Strategy: hold the signal's direction for the next bar (no look-ahead, no costs).
  let eq = 1, bh = 1, peak = 1, bhPeak = 1, mdd = 0, bhMdd = 0, exposed = 0;
  const equity: BacktestResult['equity'] = [];
  const stride = Math.max(1, Math.floor((bars.length - start) / 400));
  for (let t = start; t < bars.length - 1; t++) {
    const L = labels[t]!;
    const pos = L.includes('BUY') ? 1 : L.includes('SELL') ? -1 : 0;
    const r = bars[t + 1].close / bars[t].close - 1;
    eq *= 1 + pos * r;
    bh *= 1 + r;
    if (pos) exposed++;
    peak = Math.max(peak, eq); bhPeak = Math.max(bhPeak, bh);
    mdd = Math.min(mdd, eq / peak - 1); bhMdd = Math.min(bhMdd, bh / bhPeak - 1);
    if ((t - start) % stride === 0) equity.push({ time: bars[t + 1].time, strategy: eq, buyHold: bh });
  }

  const order: Label[] = ['STRONG BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG SELL'];
  return {
    horizon,
    bars: opts.barLabel,
    forward: opts.fwdLabel,
    from: new Date(bars[start].time * 1000).toISOString().slice(0, 10),
    to: new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10),
    samples: bars.length - fwd - start,
    factorsUsed: [...used],
    byLabel: order.map((label) => {
      const g = groups.get(label) ?? [];
      const dir = label.includes('BUY') ? 1 : label.includes('SELL') ? -1 : 0;
      return {
        label, count: g.length,
        avgFwdReturn: g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0,
        hitRate: dir && g.length ? g.filter((x) => Math.sign(x) === dir).length / g.length : null,
      };
    }),
    directionalHitRate: dirN ? hits / dirN : null,
    strategy: { totalReturn: eq - 1, maxDrawdown: mdd, exposure: exposed / Math.max(1, bars.length - 1 - start) },
    buyHold: { totalReturn: bh - 1, maxDrawdown: bhMdd },
    equity,
  };
}
