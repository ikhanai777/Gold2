// Builds every API payload from real state. All computed values carry
// `computed: true` plus the inputs they came from (SPEC §1.4).
import { config } from './config.js';
import { db } from './db.js';
import { aggregate } from './engines/aggregate.js';
import { runBacktest, macroScores, type BacktestResult, type MacroHistory } from './engines/backtest.js';
import { atr, bollinger, correlation, ema, lastValid, macd, pctChanges, pivots, rsi, sessionVwap } from './engines/indicators.js';
import { detectZones, fibRetracement, type Zone } from './engines/levels.js';
import { projectRanges, type RangeBand } from './engines/ranges.js';
import {
  combine, cotScore, FACTOR_NAMES, geoScore, momentumScore, newsScore, precompute, seasonalityScore, srScore, trendScore,
  type FactorScore, type Horizon, type HorizonResult, type Label,
} from './engines/scoring.js';
import { SPARK_SYMBOLS } from './jobs.js';
import { providerHealth } from './http.js';
import { freshness, getCandles, INSTRUMENTS, marketStatus, state, type InstrumentId } from './state.js';
import type { Candle, Freshness, SeriesPoint, Timeframe } from './types.js';

const HOUR = 3600e3, DAY = 24 * HOUR;

export function availableInstruments(): InstrumentId[] {
  return (Object.keys(INSTRUMENTS) as InstrumentId[]).filter((i) => (getCandles(i, '1d')?.bars.length ?? 0) > 0);
}

/** Spot when Twelve Data provides full spot intraday history, otherwise COMEX futures. */
export function analysisInstrument(): InstrumentId | null {
  if ((getCandles('XAUUSD', '1h')?.bars.length ?? 0) >= 300) return 'XAUUSD';
  if ((getCandles('GC=F', '1h')?.bars.length ?? 0) >= 300) return 'GC=F';
  return null;
}

// ---------------- quote/header ----------------

export function quotePayload() {
  const ms = marketStatus();
  const spot = state.spot;
  const fut = state.quotes.get('GC=F');
  const spotDaily = state.series.get('spotDaily')?.points;
  // Previous spot close only from a real spot daily source (Stooq / Twelve Data).
  const spotD = getCandles('XAUUSD', '1d');
  let prevClose: { value: number; date: string; source: string } | null = null;
  if (spotD?.bars.length) {
    const b = spotD.bars;
    const lastIsToday = Date.now() - b[b.length - 1].time * 1000 < DAY;
    const pc = lastIsToday ? b[b.length - 2] : b[b.length - 1];
    if (pc) prevClose = { value: pc.close, date: new Date(pc.time * 1000).toISOString().slice(0, 10), source: spotD.source };
  } else if (spotDaily?.length) {
    const p = spotDaily[spotDaily.length - 1];
    prevClose = { value: p.value, date: p.date, source: state.series.get('spotDaily')!.source };
  }
  return {
    market: ms,
    spot: spot ? {
      price: spot.value, source: spot.source, ts: spot.ts, fetchedAt: spot.fetchedAt,
      status: freshness(spot.fetchedAt, 15_000, !ms.open),
      change: prevClose ? spot.value - prevClose.value : null,
      changePct: prevClose ? (spot.value / prevClose.value - 1) * 100 : null,
      prevClose,
    } : null,
    bidAsk: state.bidAsk ? { ...state.bidAsk.value, source: state.bidAsk.source, ts: state.bidAsk.ts, status: freshness(state.bidAsk.fetchedAt, 15_000, !ms.open) } : null,
    futures: fut ? {
      price: fut.value.price, previousClose: fut.value.previousClose, dayHigh: fut.value.dayHigh, dayLow: fut.value.dayLow,
      change: fut.value.previousClose != null ? fut.value.price - fut.value.previousClose : null,
      changePct: fut.value.previousClose ? (fut.value.price / fut.value.previousClose - 1) * 100 : null,
      basis: spot ? fut.value.price - spot.value : null,
      source: fut.source, ts: fut.ts, status: freshness(fut.fetchedAt, 5 * 60_000, !ms.open),
    } : null,
    rejectedTicks: state.rejectedTicks,
  };
}

// ---------------- candles + indicators ----------------

const series = (c: Candle[], v: number[]) => c.map((b, i) => ({ time: b.time, value: v[i] })).filter((p) => Number.isFinite(p.value));

export function candlesPayload(inst: InstrumentId, tf: Timeframe, limit = 1500) {
  const e = getCandles(inst, tf);
  if (!e) return null;
  let bars = e.bars.slice();
  let forming: string | null = null;
  // Spot: extend the latest bar with the real tick-built forming 1m candle.
  if (inst === 'XAUUSD' && state.formingSpot && bars.length) {
    const f = state.formingSpot;
    const sec = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 }[tf];
    const bucket = tf === '1w' ? null : Math.floor(f.time / sec) * sec;
    const last = bars[bars.length - 1];
    if (bucket != null && bucket === last.time) {
      bars[bars.length - 1] = { ...last, high: Math.max(last.high, f.high), low: Math.min(last.low, f.low), close: f.close };
      forming = 'Latest bar updated from live gold-api.com ticks until the provider bar arrives';
    } else if (bucket != null && bucket > last.time && tf === '1m') {
      bars.push({ time: f.time, open: f.open, high: f.high, low: f.low, close: f.close });
      forming = 'Latest bar built from live gold-api.com ticks until the provider bar arrives';
    }
  }
  const all = bars;
  const close = all.map((b) => b.close);
  const bb = bollinger(close);
  const m = macd(close);
  const hasVol = all.some((b) => (b.volume ?? 0) > 0);
  const cut = Math.max(0, all.length - limit);
  const sl = <T,>(a: T[]) => a.filter((p: any) => p.time >= (all[cut]?.time ?? 0));
  return {
    instrument: inst, instrumentName: INSTRUMENTS[inst].name, note: INSTRUMENTS[inst].note, tf,
    source: e.source, fetchedAt: e.fetchedAt, forming,
    candles: all.slice(cut),
    volumeSource: hasVol ? (inst === 'GC=F' ? 'COMEX futures volume (Yahoo)' : 'provider volume') : null,
    indicators: {
      computed: true,
      ema20: sl(series(all, ema(close, 20))), ema50: sl(series(all, ema(close, 50))), ema200: sl(series(all, ema(close, 200))),
      bbUpper: sl(series(all, bb.upper)), bbMid: sl(series(all, bb.mid)), bbLower: sl(series(all, bb.lower)),
      vwap: hasVol && ['1m', '5m', '15m', '1h'].includes(tf) ? sl(series(all, sessionVwap(all))) : [],
      rsi: sl(series(all, rsi(close))),
      macd: sl(series(all, m.line)), macdSignal: sl(series(all, m.signal)), macdHist: sl(series(all, m.hist)),
      atr: sl(series(all, atr(all))),
    },
  };
}

// ---------------- levels ----------------

const HTF: Partial<Record<Timeframe, Timeframe>> = { '1m': '15m', '5m': '1h', '15m': '4h', '1h': '4h', '4h': '1d', '1d': '1w' };

function completedDaily(inst: InstrumentId): Candle[] {
  const d = getCandles(inst, '1d')?.bars ?? [];
  if (!d.length) return d;
  const inProgress = marketStatus().open && Date.now() - d[d.length - 1].time * 1000 < 30 * HOUR;
  return inProgress ? d.slice(0, -1) : d;
}

export function zonesFor(inst: InstrumentId, tf: Timeframe): Zone[] {
  const c = getCandles(inst, tf)?.bars ?? [];
  const h = HTF[tf];
  const fractal = tf === '1w' ? 3 : tf === '1d' ? 4 : 5;
  return detectZones(c, { fractal, lookback: 400, higherTf: h ? getCandles(inst, h)?.bars : undefined });
}

export function levelsPayload(inst: InstrumentId, tf: Timeframe) {
  const c = getCandles(inst, tf)?.bars ?? [];
  const daily = completedDaily(inst);
  const weekly = aggregate(daily, 7 * 86400, 4 * 86400);
  const months: Candle[] = [];
  for (const b of daily) {
    const d = new Date(b.time * 1000);
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    const m = months[months.length - 1];
    if (!m || m.time !== key) months.push({ ...b, time: key });
    else { m.high = Math.max(m.high, b.high); m.low = Math.min(m.low, b.low); m.close = b.close; }
  }
  const nowD = new Date();
  const curMonth = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), 1) / 1000;
  const prevMonth = months.filter((m) => m.time < curMonth).pop();
  const curWeekStart = Math.floor((Date.now() / 1000 - 4 * 86400) / (7 * 86400)) * 7 * 86400 + 4 * 86400;
  const prevWeek = weekly.filter((w) => w.time < curWeekStart).pop();
  const prevDay = daily[daily.length - 1];
  const piv = (b: Candle | undefined) => b ? { classic: pivots(b, 'classic'), fibonacci: pivots(b, 'fibonacci'), camarilla: pivots(b, 'camarilla'), basedOn: { time: b.time, high: b.high, low: b.low, close: b.close } } : null;
  return {
    instrument: inst, tf, computed: true,
    inputs: [`${c.length} ${tf} bars of ${INSTRUMENTS[inst].name}`, HTF[tf] ? `${HTF[tf]} confluence` : 'no higher-TF confluence'],
    zones: zonesFor(inst, tf),
    pivots: { day: piv(prevDay), week: piv(prevWeek), month: piv(prevMonth) },
    fib: fibRetracement(c, 150),
  };
}

// ---------------- factors ----------------

type Impact = 'Bullish' | 'Bearish' | 'Neutral';
interface FactorCard {
  id: string; name: string; group: string; value: number | null; unit: string; decimals: number;
  change1d: number | null; change1w: number | null; spark: { date: string; value: number }[];
  impact: Impact; impactNote: string; corr30d: number | null; source: string; ts: string | null;
  status: Freshness; computed?: boolean; why: string;
}

function goldDailyCloses(): Map<string, number> {
  const inst = analysisInstrument();
  const d = inst ? getCandles(inst, '1d')?.bars ?? [] : [];
  return new Map(d.map((b) => [new Date(b.time * 1000).toISOString().slice(0, 10), b.close]));
}

function corr30(points: SeriesPoint[], gold: Map<string, number>): number | null {
  const aligned = points.filter((p) => gold.has(p.date)).slice(-31);
  if (aligned.length < 20) return null;
  const c = correlation(pctChanges(aligned.map((p) => p.value)), pctChanges(aligned.map((p) => gold.get(p.date)!)));
  return Number.isFinite(c) ? c : null;
}

function chg(points: SeriesPoint[], n: number): number | null {
  return points.length > n ? points[points.length - 1].value - points[points.length - 1 - n].value : null;
}

/** dir: +1 = rising factor is bullish for gold, -1 = bearish, 0 = context only. */
function impactOf(change: number | null, dir: 1 | -1 | 0, eps = 0): { impact: Impact; note: string } {
  if (change == null || dir === 0 || Math.abs(change) <= eps) return { impact: 'Neutral', note: dir === 0 ? 'Context / non-directional' : 'Little change this week' };
  const bull = Math.sign(change) === dir;
  return { impact: bull ? 'Bullish' : 'Bearish', note: `${change > 0 ? 'Rising' : 'Falling'} over 1 week → ${bull ? 'supportive' : 'headwind'} for gold` };
}

function seriesCard(o: {
  id: string; seriesId: string; name: string; group: string; dir: 1 | -1 | 0; why: string; unit?: string; decimals?: number;
  livePrice?: { value: number; ts: string | null; fetchedAt: string; source: string } | null; expectedMs?: number; transform?: (p: SeriesPoint[]) => SeriesPoint[]; computed?: boolean; eps?: number;
}, gold: Map<string, number>): FactorCard {
  const s = state.series.get(o.seriesId);
  let pts = s?.points ?? [];
  if (o.transform) pts = o.transform(pts);
  const lastPt = pts[pts.length - 1];
  const live = o.livePrice;
  const value = live?.value ?? lastPt?.value ?? null;
  const ts = live?.ts ?? (lastPt ? lastPt.date : null);
  const c1w = chg(pts, 5);
  const im = impactOf(c1w, o.dir, o.eps);
  const ms = marketStatus();
  return {
    id: o.id, name: o.name, group: o.group, value, unit: o.unit ?? '', decimals: o.decimals ?? 2,
    change1d: live && pts.length >= 2 ? live.value - (pts[pts.length - 1].date === new Date().toISOString().slice(0, 10) ? pts[pts.length - 2] : pts[pts.length - 1]).value : chg(pts, 1),
    change1w: c1w, spark: pts.slice(-30), impact: im.impact, impactNote: im.note, corr30d: corr30(pts, gold),
    source: live ? `${live.source}; history: ${s?.source ?? 'n/a'}` : s?.source ?? 'unavailable', ts,
    status: live ? freshness(live.fetchedAt, o.expectedMs ?? 5 * 60_000, !ms.open) : s ? freshness(s.fetchedAt, 6 * HOUR) : 'unavailable',
    computed: o.computed, why: o.why,
  };
}

const liveQ = (sym: string) => {
  const q = state.quotes.get(sym);
  return q ? { value: q.value.price, ts: q.ts, fetchedAt: q.fetchedAt, source: q.source } : null;
};

export function factorsPayload(): FactorCard[] {
  const gold = goldDailyCloses();
  const cards: FactorCard[] = [];
  cards.push(seriesCard({ id: 'real10', seriesId: 'real10', name: 'US 10Y real yield (TIPS)', group: 'Rates', dir: -1, unit: '%', why: 'Strong inverse: higher real yields raise the opportunity cost of holding non-yielding gold.', eps: 0.02 }, gold));
  cards.push(seriesCard({ id: 'nom10', seriesId: 'nom10', name: 'US 10Y nominal yield', group: 'Rates', dir: -1, unit: '%', livePrice: liveQ('^TNX'), why: 'Rising yields usually weigh on gold. Live value is CBOE TNX (Yahoo); history is the official Treasury curve.', eps: 0.02 }, gold));
  cards.push(seriesCard({ id: 'nom2', seriesId: 'nom2', name: 'US 2Y yield (Fed expectations)', group: 'Rates', dir: -1, unit: '%', why: 'The 2Y tracks expected Fed policy: falling = more cuts priced = bullish gold.', eps: 0.02 }, gold));
  cards.push(seriesCard({ id: 'breakeven', seriesId: 'breakeven', name: '10Y breakeven inflation', group: 'Inflation', dir: 1, unit: '%', computed: true, why: 'Computed as Treasury 10Y nominal − 10Y real. Rising inflation expectations are usually bullish.', eps: 0.02 }, gold));
  const f = state.fed;
  cards.push({
    id: 'fed', name: 'Fed funds (EFFR / target range)', group: 'Rates', value: f?.value.effr ?? null, unit: '%', decimals: 2,
    change1d: null, change1w: null, spark: [], impact: 'Neutral', impactNote: f ? `Target ${f.value.targetFrom.toFixed(2)}–${f.value.targetTo.toFixed(2)}%` : 'unavailable',
    corr30d: null, source: f?.source ?? 'unavailable', ts: f?.ts ?? null, status: f ? freshness(f.fetchedAt, 12 * HOUR) : 'unavailable',
    why: 'Policy rate level. Direction of expected changes (see 2Y) matters more than the level.',
  });
  const cpi = state.series.get('cpi');
  if (cpi) {
    const yoy = cpi.points.map((p, i) => {
      const prev = cpi.points.find((q) => q.date === `${+p.date.slice(0, 4) - 1}${p.date.slice(4)}`);
      return prev ? { date: p.date, value: (p.value / prev.value - 1) * 100 } : null;
    }).filter(Boolean) as SeriesPoint[];
    const last = yoy[yoy.length - 1];
    const ch = yoy.length > 1 ? last.value - yoy[yoy.length - 2].value : null;
    const im = impactOf(ch, 1, 0.05);
    cards.push({ id: 'cpi', name: 'US CPI inflation (YoY)', group: 'Inflation', value: last?.value ?? null, unit: '%', decimals: 1,
      change1d: null, change1w: ch, spark: yoy.slice(-24), impact: im.impact, impactNote: ch != null ? `${ch >= 0 ? 'Up' : 'Down'} ${Math.abs(ch).toFixed(1)}pt vs prior month` : '',
      corr30d: null, source: `Computed YoY from ${cpi.source}`, ts: last?.date ?? null, status: freshness(cpi.fetchedAt, 36 * HOUR), computed: true,
      why: 'Higher inflation supports gold as a store of value over the long run (short-term it can mean a more hawkish Fed).' });
  }
  cards.push(seriesCard({ id: 'dxy', seriesId: 'dxy', name: 'US Dollar Index (DXY)', group: 'FX', dir: -1, livePrice: liveQ('DX-Y.NYB'), why: 'Inverse: gold is priced in USD, so a stronger dollar makes it dearer for other buyers.', eps: 0.1 }, gold));
  cards.push(seriesCard({ id: 'vix', seriesId: 'vix', name: 'VIX (equity fear gauge)', group: 'Risk', dir: 1, livePrice: liveQ('^VIX'), why: 'Rising fear usually brings safe-haven demand (though forced selling can hit gold briefly in crashes).', eps: 0.3 }, gold));
  cards.push(seriesCard({ id: 'gvz', seriesId: 'gvz', name: 'Gold implied volatility (GVZ)', group: 'Risk', dir: 0, livePrice: liveQ('^GVZ'), why: 'Not directional. Sets the width of the projected ranges.' }, gold));
  cards.push(seriesCard({ id: 'spx', seriesId: 'spx', name: 'S&P 500', group: 'Risk', dir: 0, livePrice: liveQ('^GSPC'), decimals: 0, why: 'Context: the gold–equity correlation shifts over time; watch the 30-day correlation.' }, gold));
  cards.push(seriesCard({ id: 'oil', seriesId: 'oil', name: 'WTI crude oil', group: 'Commodities', dir: 1, livePrice: liveQ('CL=F'), why: 'Mildly positive via the inflation channel.', eps: 0.5 }, gold));
  // Ratios computed from two real prices.
  const goldPx = state.spot?.value;
  if (goldPx && state.silver) {
    cards.push({ id: 'gsr', name: 'Gold/Silver ratio', group: 'Commodities', value: goldPx / state.silver.value, unit: '', decimals: 2, change1d: null, change1w: null,
      spark: ratioSpark('goldf', 'silverf'), impact: 'Neutral', impactNote: `Silver $${state.silver.value.toFixed(2)}`, corr30d: null,
      source: 'Computed: gold-api.com XAU / XAG spot (spark: COMEX futures ratio, Yahoo)', ts: state.silver.ts, status: freshness(state.silver.fetchedAt, 60_000, !marketStatus().open), computed: true,
      why: 'Context: a rising ratio means gold is outperforming silver (often defensive markets).' });
  }
  const cu = liveQ('HG=F'), gf = liveQ('GC=F');
  if (cu && gf) {
    cards.push({ id: 'cugold', name: 'Copper/Gold ratio (×1000)', group: 'Commodities', value: (cu.value / gf.value) * 1000, unit: '', decimals: 3, change1d: null, change1w: null,
      spark: ratioSpark('copper', 'goldf', 1000), impact: 'Neutral', impactNote: 'Growth vs safety gauge', corr30d: null,
      source: 'Computed: COMEX copper / COMEX gold futures (Yahoo)', ts: cu.ts, status: freshness(cu.fetchedAt, 5 * 60_000, !marketStatus().open), computed: true,
      why: 'Context: a rising ratio signals risk appetite and growth optimism, often alongside higher yields.' });
  }
  if (state.btc) {
    cards.push({ id: 'btc', name: 'Bitcoin', group: 'Alt assets', value: state.btc.value, unit: '$', decimals: 0, change1d: null, change1w: null, spark: [],
      impact: 'Neutral', impactNote: 'Competing "hard asset"', corr30d: null, source: state.btc.source, ts: state.btc.ts, status: freshness(state.btc.fetchedAt, 60_000), why: 'Context: competes with gold for "debasement hedge" flows.' });
  }
  const cot = state.cot;
  if (cot) {
    const s = cotScore(cot.value.map((w) => w.net));
    const pts = cot.value.map((w) => ({ date: w.date, value: w.net }));
    cards.push({ id: 'cot', name: 'CFTC managed-money net long', group: 'Positioning', value: pts[pts.length - 1]?.value ?? null, unit: 'contracts', decimals: 0,
      change1d: null, change1w: chg(pts, 1), spark: pts.slice(-30),
      impact: s.score == null ? 'Neutral' : s.score > 15 ? 'Bullish' : s.score < -15 ? 'Bearish' : 'Neutral', impactNote: s.detail, corr30d: null,
      source: cot.source, ts: cot.ts, status: freshness(cot.fetchedAt, 8 * DAY), why: 'Contrarian at extremes: very crowded longs are a downside risk; washed-out positioning supports rallies.' });
  }
  cards.push(seriesCard({ id: 'gld', seriesId: 'gld', name: 'GLD ETF holdings', group: 'Flows', dir: 1, unit: 't', decimals: 1, why: 'Inflows into the largest gold ETF signal Western investment demand.', eps: 0.5 }, gold));
  const g = state.series.get('gpr');
  if (g) {
    const gs = geoScore(g.points);
    const card = seriesCard({ id: 'gpr', seriesId: 'gpr', name: 'Geopolitical Risk index (GPR)', group: 'Risk', dir: 1, decimals: 0, why: 'Caldara–Iacoviello daily index from newspaper coverage of geopolitical tensions. Rising risk is bullish.' }, gold);
    card.impactNote = gs.detail;
    card.impact = gs.score == null ? 'Neutral' : gs.score > 15 ? 'Bullish' : gs.score < -15 ? 'Bearish' : 'Neutral';
    cards.push(card);
  }
  const inst = analysisInstrument();
  const d = inst ? getCandles(inst, '1d')?.bars : undefined;
  if (d && d.length > 300) {
    const s = seasonalityScore(d);
    cards.push({ id: 'seasonality', name: 'Seasonality (this month)', group: 'Calendar', value: s.score, unit: 'score', decimals: 0, change1d: null, change1w: null, spark: [],
      impact: s.score == null ? 'Neutral' : s.score > 5 ? 'Bullish' : s.score < -5 ? 'Bearish' : 'Neutral', impactNote: s.detail, corr30d: null,
      source: `Computed from ${getCandles(inst!, '1d')!.source}`, ts: null, status: 'live', computed: true, why: 'Historical average return for the current calendar month.' });
  }
  const ns = newsScore(state.news);
  cards.push({ id: 'news', name: 'News sentiment (24h)', group: 'News', value: ns.score, unit: 'score', decimals: 0, change1d: null, change1w: null, spark: [],
    impact: ns.score == null ? 'Neutral' : ns.score > 10 ? 'Bullish' : ns.score < -10 ? 'Bearish' : 'Neutral', impactNote: ns.detail, corr30d: null,
    source: 'Computed from the classified news feed', ts: state.news[0]?.ts ?? null, status: state.news.length ? 'live' : 'unavailable', computed: true,
    why: 'Rolling 24h average of impact × direction of gold-relevant headlines (rules-based classifier).' });
  return cards;
}

function ratioSpark(a: string, b: string, mult = 1): SeriesPoint[] {
  const A = state.series.get(a)?.points ?? [];
  const B = new Map((state.series.get(b)?.points ?? []).map((p) => [p.date, p.value]));
  return A.filter((p) => B.has(p.date)).map((p) => ({ date: p.date, value: (p.value / B.get(p.date)!) * mult })).slice(-30);
}

// ---------------- signals ----------------

export const HORIZON_TF: Record<Horizon, Timeframe> = { intraday: '1h', swing: '1d', position: '1w' };
const prevLabels: Partial<Record<Horizon, Label>> = {};
for (const h of ['intraday', 'swing', 'position'] as Horizon[]) {
  const r = db.prepare('SELECT label FROM signal_log WHERE horizon=? ORDER BY ts DESC LIMIT 1').get(h) as { label: Label } | undefined;
  if (r) prevLabels[h] = r.label;
}
const lastLogged: Partial<Record<Horizon, number>> = {};
const logSignal = db.prepare('INSERT OR REPLACE INTO signal_log (ts, horizon, score, label, confidence, price, instrument) VALUES (?, ?, ?, ?, ?, ?, ?)');

export function macroHistory(): MacroHistory {
  const s = (id: string) => state.series.get(id)?.points;
  return {
    real10: s('real10'), nom2: s('nom2'), breakeven: s('breakeven'), dxy: s('dxy'), vix: s('vix'), gpr: s('gpr'), gld: s('gld'),
    cot: state.cot?.value.map((w) => ({ date: w.date, net: w.net })),
  };
}

function nextHighImpact(withinMs: number) {
  const now = Date.now();
  return state.calendar
    .filter((e) => e.impact === 'high' && (e.country === 'USD' || /FOMC/i.test(e.event)) && Date.parse(e.ts) > now - 30 * 60e3 && Date.parse(e.ts) - now <= withinMs)
    .sort((a, b) => a.ts.localeCompare(b.ts))[0];
}

const HORIZON_WINDOW: Record<Horizon, number> = { intraday: 24 * HOUR, swing: 7 * DAY, position: 30 * DAY };

export interface SignalCard extends HorizonResult {
  tf: Timeframe; instrument: InstrumentId; price: number;
  levels: { support: Zone | null; resistance: Zone | null; atr: number; stopDistance: number };
  history: { ts: string; label: Label; score: number }[];
  lastChange: string | null;
}

let signalsCache: { ts: string; instrument: InstrumentId | null; cards: SignalCard[] } = { ts: new Date().toISOString(), instrument: null, cards: [] };
export const signalsPayload = () => signalsCache;

export function computeSignals() {
  const inst = analysisInstrument();
  if (!inst) return;
  const cards: SignalCard[] = [];
  for (const h of ['intraday', 'swing', 'position'] as Horizon[]) {
    const tf = HORIZON_TF[h];
    const bars = getCandles(inst, tf)?.bars ?? [];
    if (bars.length < 60) continue;
    const pre = precompute(bars);
    const t = bars.length - 1;
    const zones = zonesFor(inst, tf);
    const factors: FactorScore[] = [
      trendScore(pre, t), momentumScore(pre, t), srScore(bars, zones, pre.atr[t], t),
      ...macroScores(h, macroHistory(), '9999-12-31'),
      newsScore(state.news),
    ];
    const daily = getCandles(inst, '1d')?.bars;
    if (daily && daily.length > 300) factors.push(seasonalityScore(daily));
    const ev = nextHighImpact(HORIZON_WINDOW[h]);
    const r = combine(h, factors, {
      prevLabel: prevLabels[h] ?? null,
      eventRisk: ev ? { event: `${ev.country} ${ev.event}`, ts: ev.ts, hoursAway: (Date.parse(ev.ts) - Date.now()) / HOUR } : null,
    });
    const nowIso = new Date().toISOString();
    if (r.label !== prevLabels[h] || Date.now() - (lastLogged[h] ?? 0) > HOUR) {
      logSignal.run(nowIso, h, r.score, r.label, r.confidence, bars[t].close, inst);
      lastLogged[h] = Date.now();
    }
    prevLabels[h] = r.label;
    const a = lastValid(pre.atr);
    const sup = zones.filter((z) => z.kind === 'support').sort((x, y) => y.price - x.price)[0] ?? null;
    const res = zones.filter((z) => z.kind === 'resistance').sort((x, y) => x.price - y.price)[0] ?? null;
    const hist = db.prepare('SELECT ts, label, score FROM signal_log WHERE horizon=? AND ts>=? ORDER BY ts').all(h, new Date(Date.now() - 30 * DAY).toISOString()) as { ts: string; label: Label; score: number }[];
    let lastChange: string | null = null;
    for (let i = hist.length - 1; i > 0; i--) if (hist[i].label !== hist[i - 1].label) { lastChange = hist[i].ts; break; }
    cards.push({ ...r, tf, instrument: inst, price: bars[t].close, levels: { support: sup, resistance: res, atr: a, stopDistance: 1.5 * a }, history: hist, lastChange });
  }
  signalsCache = { ts: new Date().toISOString(), instrument: inst, cards };
}

// ---------------- ranges ----------------

let rangesCache: { instrument: InstrumentId | null; bands: RangeBand[]; ts: string } = { instrument: null, bands: [], ts: new Date().toISOString() };
export const rangesPayload = () => rangesCache;
const logRange = db.prepare('INSERT OR IGNORE INTO range_log (period, period_start, instrument, open, low, high, ext_low, ext_high, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

export function computeRanges() {
  const inst = analysisInstrument();
  if (!inst) return;
  const daily = getCandles(inst, '1d')?.bars ?? [];
  const sc = Object.fromEntries(signalsCache.cards.map((c) => [c.horizon, c.score]));
  const bands = projectRanges(daily, state.series.get('gvz')?.points ?? [], { day: sc.intraday ?? 0, week: sc.swing ?? 0, month: sc.position ?? 0 }, zonesFor(inst, '1d'));
  for (const b of bands) logRange.run(b.period, new Date(b.periodStart * 1000).toISOString(), inst, b.open, b.low, b.high, b.extLow, b.extHigh, new Date().toISOString());
  rangesCache = { instrument: inst, bands, ts: new Date().toISOString() };
}

// ---------------- performance ----------------

let perfCache: { ts: string | null; instrument: InstrumentId | null; backtests: BacktestResult[]; note: string } = { ts: null, instrument: null, backtests: [], note: 'Backtest runs once enough history has loaded.' };
let perfRunning = false;

export function computePerformance() {
  const inst = analysisInstrument();
  if (!inst || perfRunning) return;
  if (!state.series.get('real10') || !state.series.get('dxy')) return; // wait for macro history
  perfRunning = true;
  try {
    const t0 = Date.now();
    const macro = macroHistory();
    const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    const daily = getCandles(inst, '1d')!.bars;
    const out: BacktestResult[] = [];
    const h1 = getCandles(inst, '1h')?.bars ?? [];
    const intr = runBacktest({ horizon: 'intraday', bars: h1, fwd: 8, barLabel: '1h bars', fwdLabel: 'next 8 hours', macro, cutoffFor: (b) => day(b.time), maxEval: 3000 });
    if (intr) out.push(intr);
    const sw = runBacktest({ horizon: 'swing', bars: daily, fwd: 5, barLabel: 'daily bars', fwdLabel: 'next 5 trading days', macro, cutoffFor: (b) => day(b.time), maxEval: 1500 });
    if (sw) out.push(sw);
    const weekly = aggregate(daily, 7 * 86400, 4 * 86400).slice(0, -1); // completed weeks only
    const pos = runBacktest({ horizon: 'position', bars: weekly, fwd: 4, barLabel: 'weekly bars', fwdLabel: 'next 4 weeks', macro, daily, cutoffFor: (b) => day(b.time + 4 * 86400), warmup: 200, maxEval: 500 });
    if (pos) out.push(pos);
    perfCache = { ts: new Date().toISOString(), instrument: inst, backtests: out, note: `Computed in ${((Date.now() - t0) / 1000).toFixed(1)} s on real history. No transaction costs; not a guarantee of future results.` };
  } finally {
    perfRunning = false;
  }
}

export function performancePayload() {
  const inst = rangesCache.instrument;
  // Forward-tracking of published ranges whose period has ended.
  const rows = db.prepare('SELECT * FROM range_log ORDER BY period_start DESC LIMIT 200').all() as any[];
  const daily = inst ? getCandles(inst, '1d')?.bars ?? [] : [];
  const tracked = rows.map((r) => {
    const start = Date.parse(r.period_start) / 1000;
    const len = r.period === 'day' ? 1 : r.period === 'week' ? 7 : 31;
    const end = start + len * 86400;
    if (Date.now() / 1000 < end || r.instrument !== inst) return null;
    const inPeriod = daily.filter((b) => b.time >= start && b.time < end);
    if (!inPeriod.length) return null;
    const close = inPeriod[inPeriod.length - 1].close;
    return { period: r.period, periodStart: r.period_start, low: r.low, high: r.high, close, inside: close >= r.low && close <= r.high };
  }).filter(Boolean);
  const sig = db.prepare('SELECT * FROM signal_log ORDER BY ts DESC LIMIT 500').all();
  return { ...perfCache, forward: { ranges: tracked, signals: sig, since: state.startedAt } };
}

// ---------------- status ----------------

export function statusPayload() {
  return {
    startedAt: state.startedAt,
    analysisInstrument: analysisInstrument(),
    instruments: availableInstruments().map((i) => ({ id: i, ...INSTRUMENTS[i] })),
    keys: { twelveData: !!config.keys.twelveData, fred: !!config.keys.fred, finnhub: !!config.keys.finnhub },
    providers: providerHealth(),
    market: marketStatus(),
    sparkSymbols: SPARK_SYMBOLS,
    factorNames: FACTOR_NAMES,
  };
}
