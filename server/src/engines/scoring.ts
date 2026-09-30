// Scoring model (SPEC §6.3). Each factor → sub-score in [-100, 100]
// (positive = bullish gold). Horizon score = weighted mean over available
// factors; unavailable factors are excluded and weights re-normalised.
import weightsFile from '../../../config/weights.json' with { type: 'json' };
import type { Candle, SeriesPoint } from '../types.js';
import { adx, atr, changeZ, clamp, ema, macd, rsi } from './indicators.js';
import type { Zone } from './levels.js';

export type Horizon = 'intraday' | 'swing' | 'position';
export type FactorId = 'trend' | 'momentum' | 'sr' | 'realYields' | 'dxy' | 'fedExp' | 'breakevens' | 'vix' | 'geo' | 'etf' | 'cot' | 'news' | 'seasonality';
export type Label = 'STRONG BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG SELL';

export const FACTOR_NAMES: Record<FactorId, string> = {
  trend: 'Trend (EMA 20/50/200, ADX)', momentum: 'Momentum (MACD, RSI)', sr: 'Price vs support/resistance',
  realYields: 'US 10Y real yield', dxy: 'US Dollar (DXY)', fedExp: 'Fed expectations (2Y yield)', breakevens: '10Y breakeven inflation',
  vix: 'Risk sentiment (VIX)', geo: 'Geopolitical risk (GPR)', etf: 'GLD ETF holdings', cot: 'CFTC managed-money positioning',
  news: 'News sentiment (24h)', seasonality: 'Seasonality',
};

export const WEIGHTS = weightsFile as unknown as Record<Horizon, Record<FactorId, number>>;
export const THRESHOLDS: { strongBuy: number; buy: number; sell: number; strongSell: number; hysteresis: number } = weightsFile.thresholds;

export interface FactorScore { id: FactorId; score: number | null; detail: string }

// ---------- technical sub-scores (evaluated at index t, using bars ≤ t only) ----------

export interface TechPre { close: number[]; e20: number[]; e50: number[]; e200: number[]; adx: number[]; hist: number[]; rsi: number[]; atr: number[] }

export function precompute(c: Candle[]): TechPre {
  const close = c.map((b) => b.close);
  return { close, e20: ema(close, 20), e50: ema(close, 50), e200: ema(close, 200), adx: adx(c), hist: macd(close).hist, rsi: rsi(close), atr: atr(c) };
}

export function trendScore(p: TechPre, t: number): FactorScore {
  const px = p.close[t];
  const votes: number[] = [];
  const parts: string[] = [];
  for (const [n, e] of [['EMA20', p.e20], ['EMA50', p.e50], ['EMA200', p.e200]] as const) {
    if (Number.isFinite(e[t])) { votes.push(px > e[t] ? 1 : -1); parts.push(`${px > e[t] ? '>' : '<'}${n}`); }
  }
  if (Number.isFinite(p.e50[t])) votes.push(p.e20[t] > p.e50[t] ? 1 : -1);
  if (Number.isFinite(p.e200[t])) votes.push(p.e50[t] > p.e200[t] ? 1 : -1);
  if (Number.isFinite(p.e50[t - 5])) votes.push(p.e50[t] > p.e50[t - 5] ? 1 : -1);
  if (votes.length < 3) return { id: 'trend', score: null, detail: 'insufficient history' };
  let s = (votes.reduce((a, b) => a + b, 0) / votes.length) * 100;
  const a = p.adx[t];
  let adxNote = '';
  if (Number.isFinite(a)) {
    if (a > 25) { s *= 1.2; adxNote = `ADX ${a.toFixed(0)} strong`; }
    else if (a < 20) { s *= 0.7; adxNote = `ADX ${a.toFixed(0)} weak`; }
    else adxNote = `ADX ${a.toFixed(0)}`;
  }
  return { id: 'trend', score: clamp(s, -100, 100), detail: `Price ${parts.join(' ')}; ${adxNote}` };
}

export function momentumScore(p: TechPre, t: number): FactorScore {
  const h = p.hist[t], r = p.rsi[t];
  if (!Number.isFinite(h) || !Number.isFinite(r)) return { id: 'momentum', score: null, detail: 'insufficient history' };
  let s = h > 0 ? 40 : -40;
  if (Number.isFinite(p.hist[t - 3])) s += h > p.hist[t - 3] ? 20 : -20;
  if (r > 70) s += 40 - (r - 70) * 4; // overbought: fade
  else if (r >= 50) s += (r - 50) * 2;
  else if (r >= 30) s -= (50 - r) * 2;
  else s += -40 + (30 - r) * 4; // oversold: bounce potential
  return { id: 'momentum', score: clamp(s, -100, 100), detail: `MACD hist ${h >= 0 ? '+' : ''}${h.toFixed(2)}, RSI ${r.toFixed(0)}` };
}

export function srScore(c: Candle[], zones: Zone[], atrNow: number, t = c.length - 1): FactorScore {
  const px = c[t].close;
  if (!Number.isFinite(atrNow) || atrNow <= 0 || t < 21) return { id: 'sr', score: null, detail: 'insufficient history' };
  let s = 0;
  const sup = zones.filter((z) => z.kind === 'support').sort((a, b) => b.price - a.price)[0];
  const res = zones.filter((z) => z.kind === 'resistance').sort((a, b) => a.price - b.price)[0];
  const notes: string[] = [];
  if (sup && res) {
    const ds = (px - sup.price) / atrNow, dr = (res.price - px) / atrNow;
    s += ((dr - ds) / (dr + ds || 1)) * 50 * ((sup.strength + res.strength) / 20 + 0.5);
    notes.push(`${ds.toFixed(1)} ATR above ${sup.label}, ${dr.toFixed(1)} ATR below ${res.label}`);
  } else if (sup) { s += 20; notes.push('no resistance overhead in lookback'); }
  else if (res) { s -= 20; notes.push('no support below in lookback'); }
  let hh = -Infinity, ll = Infinity;
  for (let i = t - 20; i < t; i++) { hh = Math.max(hh, c[i].high); ll = Math.min(ll, c[i].low); }
  if (px > hh) { s += 40; notes.push('20-bar breakout'); }
  if (px < ll) { s -= 40; notes.push('20-bar breakdown'); }
  return { id: 'sr', score: clamp(s, -100, 100), detail: notes.join('; ') };
}

// ---------- macro sub-scores ----------

const zs = (z: number, sign: 1 | -1) => clamp(sign * z * 40, -100, 100);

/** z-score of the last `lag`-point change in a series; sign = -1 for inverse relationships. */
export function seriesScore(id: FactorId, series: SeriesPoint[] | null | undefined, lag: number, sign: 1 | -1, unit = ''): FactorScore {
  if (!series || series.length < lag + 30) return { id, score: null, detail: 'data unavailable' };
  const v = series.map((p) => p.value);
  const z = changeZ(v, lag);
  const ch = v[v.length - 1] - v[v.length - 1 - lag];
  return { id, score: Number.isFinite(z) ? zs(z, sign) : null, detail: `${lag}-obs change ${ch >= 0 ? '+' : ''}${ch.toFixed(unit === '%' ? 2 : 2)}${unit} (z ${z.toFixed(2)})` };
}

export function cotScore(nets: number[]): FactorScore {
  if (nets.length < 52) return { id: 'cot', score: null, detail: 'data unavailable' };
  const hist = nets.slice(-156);
  const x = hist[hist.length - 1];
  const pct = hist.filter((h) => h <= x).length / hist.length;
  return { id: 'cot', score: clamp((-(pct - 0.5) / 0.4) * 60, -60, 60), detail: `Managed-money net ${x.toLocaleString('en-US')} = ${(pct * 100).toFixed(0)}th pct of 3y (contrarian)` };
}

export function geoScore(gpr: SeriesPoint[] | null | undefined): FactorScore {
  if (!gpr || gpr.length < 300) return { id: 'geo', score: null, detail: 'data unavailable' };
  const v = gpr.map((p) => p.value);
  const ma7: number[] = [];
  for (let i = 6; i < v.length; i++) ma7.push(v.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7);
  const hist = ma7.slice(-365);
  const m = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - m) ** 2, 0) / hist.length);
  const z = sd ? (hist[hist.length - 1] - m) / sd : 0;
  return { id: 'geo', score: zs(z, 1), detail: `GPR 7-day avg ${hist[hist.length - 1].toFixed(0)} vs 1y mean ${m.toFixed(0)} (z ${z.toFixed(2)})` };
}

export function seasonalityScore(daily: Candle[], at = daily.length - 1): FactorScore {
  const month = new Date(daily[at].time * 1000).getUTCMonth();
  const rets: number[] = [];
  let first: Candle | null = null, prevM = -1, prevY = -1, lastBar: Candle | null = null;
  for (let i = 0; i < at; i++) {
    const d = new Date(daily[i].time * 1000);
    const m = d.getUTCMonth(), y = d.getUTCFullYear();
    if (m !== prevM || y !== prevY) {
      if (first && lastBar && prevM === month && y !== undefined) rets.push(lastBar.close / first.open - 1);
      first = daily[i]; prevM = m; prevY = y;
    }
    lastBar = daily[i];
  }
  // exclude the current (incomplete) month by construction: loop ends before `at`'s month closes
  if (rets.length < 5) return { id: 'seasonality', score: null, detail: 'insufficient history' };
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length) || 1;
  const up = rets.filter((r) => r > 0).length / rets.length;
  const name = new Date(Date.UTC(2000, month, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return { id: 'seasonality', score: clamp((m / sd) * 60, -30, 30), detail: `${name}: avg ${(m * 100).toFixed(2)}%, up ${(up * 100).toFixed(0)}% of ${rets.length} yrs` };
}

export function newsScore(items: { ts: string; direction: number; impact: number }[], now = Date.now()): FactorScore {
  const recent = items.filter((n) => now - Date.parse(n.ts) <= 24 * 3600e3 && n.impact > 0);
  if (recent.length < 3) return { id: 'news', score: null, detail: `only ${recent.length} relevant items in 24h` };
  const idx = recent.reduce((a, n) => a + n.direction * n.impact, 0) / recent.length; // -5..5
  return { id: 'news', score: clamp((idx / 5) * 100 * 2, -100, 100), detail: `${recent.length} items, sentiment index ${idx.toFixed(2)} (−5…+5)` };
}

// ---------- combination ----------

export interface Contribution { id: FactorId; name: string; score: number; weight: number; contribution: number; detail: string }

export interface HorizonResult {
  horizon: Horizon;
  score: number;
  rawScore: number;
  label: Label;
  confidence: 'Low' | 'Medium' | 'High';
  contributions: Contribution[];
  excluded: { id: FactorId; name: string; reason: string }[];
  agreement: number;
  eventRisk: { event: string; ts: string } | null;
}

export function labelFor(score: number, prev?: Label | null): Label {
  const T = THRESHOLDS;
  const raw: Label = score >= T.strongBuy ? 'STRONG BUY' : score >= T.buy ? 'BUY' : score > T.sell ? 'NEUTRAL' : score > T.strongSell ? 'SELL' : 'STRONG SELL';
  if (!prev || prev === raw) return raw;
  // Hysteresis: only switch once the score is ≥ `hysteresis` points past the boundary.
  const order: Label[] = ['STRONG SELL', 'SELL', 'NEUTRAL', 'BUY', 'STRONG BUY'];
  const bounds = [T.strongSell, T.sell, T.buy, T.strongBuy]; // boundary between order[i] and order[i+1]
  const pi = order.indexOf(prev), ri = order.indexOf(raw);
  if (ri > pi) return score >= bounds[ri - 1] + T.hysteresis ? raw : order[Math.max(pi, ri - 1)];
  return score <= bounds[ri] - T.hysteresis ? raw : order[Math.min(pi, ri + 1)];
}

export function combine(
  horizon: Horizon,
  factors: FactorScore[],
  opts: { prevLabel?: Label | null; eventRisk?: { event: string; ts: string; hoursAway: number } | null } = {},
): HorizonResult {
  const w = WEIGHTS[horizon];
  const used = factors.filter((f) => f.score != null && (w[f.id] ?? 0) > 0);
  const excluded = factors
    .filter((f) => (w[f.id] ?? 0) > 0 && f.score == null)
    .map((f) => ({ id: f.id, name: FACTOR_NAMES[f.id], reason: f.detail }));
  const wSum = used.reduce((a, f) => a + w[f.id], 0);
  const totalW = Object.values(w).reduce((a, b) => a + b, 0);
  const contributions: Contribution[] = used.map((f) => ({
    id: f.id, name: FACTOR_NAMES[f.id], score: f.score!, weight: wSum ? w[f.id] / wSum : 0,
    contribution: wSum ? (w[f.id] * f.score!) / wSum : 0, detail: f.detail,
  }));
  const rawScore = clamp(contributions.reduce((a, c) => a + c.contribution, 0), -100, 100);
  let score = rawScore;
  const pos = contributions.filter((c) => c.contribution > 0).reduce((a, c) => a + c.contribution, 0);
  const neg = -contributions.filter((c) => c.contribution < 0).reduce((a, c) => a + c.contribution, 0);
  const agreement = pos + neg > 0 ? Math.max(pos, neg) / (pos + neg) : 0;
  let confidence: HorizonResult['confidence'] = agreement > 0.7 ? 'High' : agreement < 0.55 ? 'Low' : 'Medium';
  if (wSum < 0.7 * totalW) confidence = confidence === 'High' ? 'Medium' : 'Low'; // >30% of weight missing
  if (wSum === 0) confidence = 'Low';
  const er = opts.eventRisk ?? null;
  if (er && horizon === 'intraday' && er.hoursAway <= 2) { score *= 0.6; confidence = 'Low'; }
  return {
    horizon, score, rawScore, label: labelFor(score, opts.prevLabel), confidence,
    contributions: contributions.sort((a, b) => b.contribution - a.contribution),
    excluded, agreement, eventRisk: er ? { event: er.event, ts: er.ts } : null,
  };
}
