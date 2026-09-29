// Pollers. Each provider is polled once on the backend and fanned out to all
// clients, keeping usage inside free tiers (SPEC §4.5). Failures leave the last
// real value in place (with its original timestamp) — nothing is estimated.
import { config } from './config.js';
import { db, loadCandles, saveCandles } from './db.js';
import { aggregate, mergeCandles, toWeekly } from './engines/aggregate.js';
import { classify, normTitle, similarity } from './engines/newsClassify.js';
import { blsCpi, cftcGold, fredReleaseDates, fredSeries, gldHoldings, gprDaily, nyFedEffr, treasuryCurve } from './providers/macro.js';
import { fetchFinnhub, fetchFomcDates, fetchForexFactory, fetchGdelt, fetchRss, RSS_FEEDS, type CalEvent, type RawNews } from './providers/news.js';
import { coinbaseBtc, goldApiSpot, stooqDaily, swissquoteBidAsk, twelveDataSeries, yahooChart, yahooSpark } from './providers/prices.js';
import { getCandles, marketStatus, setCandles, setSeries, state, type InstrumentId, type NewsItem } from './state.js';
import type { Candle, SeriesPoint } from './types.js';
import { TF_SECONDS } from './types.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
export const onEvent = (l: Listener) => (listeners.add(l), () => listeners.delete(l));
export const emit = (event: string, data: unknown) => listeners.forEach((l) => l(event, data));

const running = new Set<string>();
function every(name: string, ms: number, fn: () => Promise<void>, delayMs = 0) {
  const run = async () => {
    if (running.has(name)) return;
    running.add(name);
    try { await fn(); } catch (e) { log(`[job ${name}]`, e instanceof Error ? e.message : e); } finally { running.delete(name); }
  };
  setTimeout(() => { run(); setInterval(run, ms); }, delayMs);
}
const now = () => new Date().toISOString();

// ---------------- live prices ----------------

async function spotTick() {
  const q = await goldApiSpot('XAU');
  const prev = state.spot;
  if (prev && Date.now() - Date.parse(prev.fetchedAt) < 60_000 && Math.abs(q.price / prev.value - 1) > 0.03) {
    // Sanity check (SPEC §4.4): a >3% jump in <1 min needs a second source to confirm.
    const ba = state.bidAsk?.value;
    const mid = ba ? (ba.bid + ba.ask) / 2 : null;
    if (!mid || Math.abs(q.price / mid - 1) > 0.005) {
      state.rejectedTicks++;
      log('[spot] rejected unconfirmed tick', q.price, 'prev', prev.value);
      return;
    }
  }
  state.spot = { value: q.price, source: q.source, ts: q.ts, fetchedAt: now() };
  // Forming 1m spot candle from real ticks (only when a spot candle source exists).
  if (config.keys.twelveData) {
    const t = Math.floor(Date.parse(q.ts) / 60000) * 60;
    const f = state.formingSpot;
    if (!f || f.time !== t) state.formingSpot = { time: t, open: q.price, high: q.price, low: q.price, close: q.price, ticks: 1 };
    else { f.high = Math.max(f.high, q.price); f.low = Math.min(f.low, q.price); f.close = q.price; f.ticks++; }
  }
  emit('quote', { spot: state.spot, bidAsk: state.bidAsk });
}

async function bidAskTick() {
  const b = await swissquoteBidAsk();
  state.bidAsk = { value: { bid: b.bid, ask: b.ask }, source: b.source, ts: b.ts, fetchedAt: now() };
}

async function silverTick() {
  const q = await goldApiSpot('XAG');
  state.silver = { value: q.price, source: q.source, ts: q.ts, fetchedAt: now() };
}

async function btcTick() {
  const q = await coinbaseBtc();
  state.btc = { value: q.price, source: q.source, ts: q.ts, fetchedAt: now() };
}

export const SPARK_SYMBOLS: Record<string, { id: string; name: string }> = {
  'DX-Y.NYB': { id: 'dxy', name: 'US Dollar Index (DXY)' },
  '^VIX': { id: 'vix', name: 'CBOE VIX' },
  '^GVZ': { id: 'gvz', name: 'CBOE Gold Volatility (GVZ)' },
  '^TNX': { id: 'tnx', name: '10Y Treasury yield (CBOE TNX)' },
  'CL=F': { id: 'oil', name: 'WTI crude futures' },
  'HG=F': { id: 'copper', name: 'COMEX copper futures' },
  '^GSPC': { id: 'spx', name: 'S&P 500' },
  'SI=F': { id: 'silverf', name: 'COMEX silver futures' },
  'GC=F': { id: 'goldf', name: 'COMEX gold futures' },
};

async function sparkLive() {
  const m = await yahooSpark(Object.keys(SPARK_SYMBOLS), '1d', '5m');
  for (const [sym, s] of m) {
    if (s.price == null) continue;
    state.quotes.set(sym, {
      value: { price: s.price, previousClose: s.previousClose, dayHigh: s.dayHigh, dayLow: s.dayLow },
      source: 'Yahoo Finance (unofficial)', ts: s.priceTime, fetchedAt: now(),
    });
  }
  emit('quotes', null);
}

const toDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

async function sparkDaily() {
  const m = await yahooSpark(Object.keys(SPARK_SYMBOLS), '10y', '1d');
  for (const [sym, s] of m) {
    const meta = SPARK_SYMBOLS[sym];
    if (!meta) continue;
    // One point per calendar date (last close of that date).
    const byDate = new Map<string, number>();
    for (const p of s.points) byDate.set(toDate(p.time), p.close);
    setSeries(meta.id, [...byDate].map(([date, value]) => ({ date, value })), 'Yahoo Finance (unofficial)');
  }
}

// ---------------- candles ----------------

/** Refresh the latest bars of a higher timeframe from real 1m bars. */
function refreshFromBase(tfBars: Candle[], base: Candle[], sec: number): Candle[] {
  if (!tfBars.length || !base.length) return tfBars;
  const last = tfBars[tfBars.length - 1];
  const buckets = aggregate(base.filter((b) => b.time >= last.time), sec);
  const out = tfBars.slice();
  for (const b of buckets) {
    const coveredFromStart = base[0].time <= b.time;
    if (b.time === last.time) {
      out[out.length - 1] = coveredFromStart
        ? b
        : { ...last, high: Math.max(last.high, b.high), low: Math.min(last.low, b.low), close: b.close };
    } else if (b.time > last.time && coveredFromStart) out.push(b);
  }
  return out;
}

function refreshHigherTfs(inst: InstrumentId, source: string) {
  const base = getCandles(inst, '1m')?.bars ?? [];
  for (const tf of ['5m', '15m', '1h', '4h'] as const) {
    const cur = getCandles(inst, tf);
    if (cur) setCandles(inst, tf, refreshFromBase(cur.bars, base, TF_SECONDS[tf]), cur.source);
  }
  const d = getCandles(inst, '1d');
  if (d && base.length) {
    // Update the in-progress daily bar's high/low/close from newer 1m bars (no new daily buckets from 1m).
    const bars = d.bars.slice();
    const lastD = bars[bars.length - 1];
    // Session window of the last daily bar: Yahoo stamps GC=F dailies at 00:00 ET of the
    // trading date (session ends 17:00 ET ≈ +18h max); Twelve Data uses UTC days.
    const end = lastD.time + (inst === 'GC=F' ? 18 : 24) * 3600;
    const newer = base.filter((b) => b.time * 1000 > Date.parse(d.fetchedAt) - 60_000 && b.time >= lastD.time && b.time < end);
    if (newer.length && Date.now() / 1000 - lastD.time < 30 * 3600) {
      bars[bars.length - 1] = { ...lastD, high: Math.max(lastD.high, ...newer.map((b) => b.high)), low: Math.min(lastD.low, ...newer.map((b) => b.low)), close: newer[newer.length - 1].close };
      state.candles.set(`${inst}:1d`, { ...d, bars });
    }
    setCandles(inst, '1w', toWeekly(getCandles(inst, '1d')!.bars), `${d.source} (weekly aggregated from daily)`);
  }
  void source;
}

const YF = 'Yahoo Finance GC=F (COMEX futures, unofficial)';

async function futuresBackfill() {
  const specs: [string, string, string][] = [['1m', '1m', '5d'], ['5m', '5m', '1mo'], ['15m', '15m', '1mo'], ['1h', '60m', '730d'], ['1d', '1d', '25y']];
  for (const [tf, interval, range] of specs) {
    const r = await yahooChart('GC=F', interval, range);
    let bars = r.candles;
    if (tf === '1m') {
      saveCandles('GC=F', '1m', bars, YF);
      bars = mergeCandles(loadCandles('GC=F', '1m', Math.floor(Date.now() / 1000) - 7 * 86400), bars);
    }
    setCandles('GC=F', tf, bars, YF);
    if (tf === '1h') setCandles('GC=F', '4h', aggregate(bars, TF_SECONDS['4h']), `${YF} (4h aggregated from 1h)`);
    if (tf === '1d') setCandles('GC=F', '1w', toWeekly(bars), `${YF} (weekly aggregated from daily)`);
  }
  log('[futures] backfill done', ['1m', '5m', '15m', '1h', '4h', '1d', '1w'].map((tf) => `${tf}:${getCandles('GC=F', tf)?.bars.length}`).join(' '));
}

async function futures1m() {
  if (!getCandles('GC=F', '1m')) return;
  const r = await yahooChart('GC=F', '1m', '1d');
  saveCandles('GC=F', '1m', r.candles, YF);
  const cutoff = Date.now() / 1000 - 7 * 86400;
  setCandles('GC=F', '1m', mergeCandles(getCandles('GC=F', '1m')!.bars, r.candles).filter((b) => b.time >= cutoff), YF);
  refreshHigherTfs('GC=F', YF);
  emit('candles', { instrument: 'GC=F' });
}

async function futuresRefresh() {
  if (!getCandles('GC=F', '1d')) return;
  for (const [tf, interval, range] of [['5m', '5m', '5d'], ['15m', '15m', '5d'], ['1h', '60m', '1mo'], ['1d', '1d', '1mo']] as const) {
    const r = await yahooChart('GC=F', interval, range);
    const cur = getCandles('GC=F', tf);
    setCandles('GC=F', tf, mergeCandles(cur?.bars ?? [], r.candles), YF);
  }
  const h = getCandles('GC=F', '1h')!.bars;
  setCandles('GC=F', '4h', aggregate(h, TF_SECONDS['4h']), `${YF} (4h aggregated from 1h)`);
  setCandles('GC=F', '1w', toWeekly(getCandles('GC=F', '1d')!.bars), `${YF} (weekly aggregated from daily)`);
}

const TD = 'Twelve Data XAU/USD (spot)';

async function spotBackfill() {
  if (!config.keys.twelveData) return;
  for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) {
    const bars = await twelveDataSeries(tf, 5000);
    if (tf === '1m') saveCandles('XAUUSD', '1m', bars, TD);
    setCandles('XAUUSD', tf, tf === '1m' ? mergeCandles(loadCandles('XAUUSD', '1m', Math.floor(Date.now() / 1000) - 7 * 86400), bars) : bars, TD);
  }
  setCandles('XAUUSD', '1w', toWeekly(getCandles('XAUUSD', '1d')!.bars), `${TD} (weekly aggregated from daily)`);
  log('[spot] Twelve Data backfill done');
}

async function spot1m() {
  if (!config.keys.twelveData || !getCandles('XAUUSD', '1m')) return;
  if (!marketStatus().open) return; // save free credits while the market is closed
  const bars = await twelveDataSeries('1m', 15);
  saveCandles('XAUUSD', '1m', bars, TD);
  const cutoff = Date.now() / 1000 - 7 * 86400;
  setCandles('XAUUSD', '1m', mergeCandles(getCandles('XAUUSD', '1m')!.bars, bars).filter((b) => b.time >= cutoff), TD);
  // Provider bar replaces the tick-built forming bar once available.
  if (state.formingSpot && bars.some((b) => b.time === state.formingSpot!.time)) state.formingSpot = null;
  refreshHigherTfs('XAUUSD', TD);
  emit('candles', { instrument: 'XAUUSD' });
}

async function spotRefreshHigher() {
  if (!config.keys.twelveData || !getCandles('XAUUSD', '1d')) return;
  for (const tf of ['1h', '4h', '1d'] as const) {
    const bars = await twelveDataSeries(tf, 60);
    setCandles('XAUUSD', tf, mergeCandles(getCandles('XAUUSD', tf)?.bars ?? [], bars), TD);
  }
  setCandles('XAUUSD', '1w', toWeekly(getCandles('XAUUSD', '1d')!.bars), `${TD} (weekly aggregated from daily)`);
}

async function stooq() {
  const bars = await stooqDaily();
  setSeries('spotDaily', bars.map((b) => ({ date: toDate(b.time), value: b.close })), 'Stooq XAUUSD daily (spot)');
  if (!config.keys.twelveData) {
    setCandles('XAUUSD', '1d', bars, 'Stooq XAUUSD daily (spot)');
    setCandles('XAUUSD', '1w', toWeekly(bars), 'Stooq XAUUSD (weekly aggregated from daily)');
  }
}

// ---------------- macro ----------------

let treasuryYearsLoaded = false;
async function treasury() {
  const y = new Date().getUTCFullYear();
  const years = treasuryYearsLoaded ? [y] : Array.from({ length: 11 }, (_, i) => y - 10 + i);
  const [nom, real] = await Promise.all([treasuryCurve('nominal', years), treasuryCurve('real', years)]);
  const merge = (id: string, pts: SeriesPoint[] | undefined, src: string) => {
    if (!pts?.length) return;
    const old = treasuryYearsLoaded ? state.series.get(id)?.points ?? [] : [];
    const m = new Map(old.map((p) => [p.date, p.value]));
    for (const p of pts) m.set(p.date, p.value);
    setSeries(id, [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value })), src, '%');
  };
  merge('real10', real['10 YR'], 'U.S. Treasury — daily real yield curve (10Y)');
  merge('nom10', nom['10 Yr'], 'U.S. Treasury — daily par yield curve (10Y)');
  merge('nom2', nom['2 Yr'], 'U.S. Treasury — daily par yield curve (2Y)');
  // Breakeven = nominal − real on the same date (computed from two official series).
  const r = new Map(state.series.get('real10')?.points.map((p) => [p.date, p.value]) ?? []);
  const be = (state.series.get('nom10')?.points ?? []).filter((p) => r.has(p.date)).map((p) => ({ date: p.date, value: +(p.value - r.get(p.date)!).toFixed(3) }));
  setSeries('breakeven', be, 'Computed: Treasury 10Y nominal − 10Y real', '%');
  treasuryYearsLoaded = true;
}

async function nyfed() {
  const f = await nyFedEffr();
  state.fed = { value: f, source: 'Federal Reserve Bank of New York (EFFR)', ts: f.date, fetchedAt: now() };
}

async function cpi() {
  let pts: SeriesPoint[];
  let src: string;
  if (config.keys.fred) { pts = await fredSeries('CPIAUCSL', '2015-01-01'); src = 'FRED CPIAUCSL (seasonally adjusted)'; }
  else { pts = await blsCpi(); src = 'BLS CPI-U (CUUR0000SA0, not seasonally adjusted)'; }
  setSeries('cpi', pts, src);
}

async function cftc() {
  const weeks = await cftcGold(260);
  state.cot = { value: weeks, source: 'CFTC Disaggregated Futures-Only, Gold COMEX (088691)', ts: weeks[weeks.length - 1]?.date ?? null, fetchedAt: now() };
}

async function gld() {
  setSeries('gld', await gldHoldings(), 'SPDR Gold Shares historical archive (tonnes)', 't');
}

async function gpr() {
  setSeries('gpr', await gprDaily(), 'Caldara & Iacoviello Geopolitical Risk Index (daily GPRD)');
}

// ---------------- news ----------------

const insertNews = db.prepare(`INSERT OR IGNORE INTO news (id, ts, title, url, source, feed, snippet, topic, direction, impact, rationale, fetched_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

function hashId(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function ingestNews(raw: RawNews[], feed: string) {
  const cutoff = Date.now() - 48 * 3600e3;
  const existing = state.news;
  const norms = existing.map((n) => normTitle(n.title));
  let added = 0;
  for (const r of raw) {
    if (Date.parse(r.ts) < cutoff || Date.parse(r.ts) > Date.now() + 10 * 60e3) continue;
    if (existing.some((n) => n.url === r.url)) continue;
    const nt = normTitle(r.title);
    if (norms.some((x) => x === nt || similarity(x, nt) > 0.85)) continue;
    const c = classify(r.title, r.snippet, r.tone);
    const item: NewsItem = { id: hashId(r.url), title: r.title, url: r.url, source: r.source, feed: r.feed, ts: r.ts, snippet: r.snippet, ...c };
    existing.push(item);
    norms.push(nt);
    insertNews.run(item.id, item.ts, item.title, item.url, item.source, item.feed, item.snippet, item.topic, item.direction, item.impact, item.rationale, now());
    added++;
  }
  state.news = existing.filter((n) => Date.parse(n.ts) >= cutoff).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 600);
  state.newsFetchedAt.set(feed, now());
  if (added) emit('news', { added });
}

// ---------------- calendar ----------------

const FRED_KEY_RELEASES: Record<number, string> = {
  10: 'CPI', 50: 'Employment Situation (NFP)', 53: 'GDP', 54: 'Personal Income & Outlays (PCE)', 46: 'PPI', 9: 'Retail Sales', 192: 'JOLTS', 180: 'Initial Jobless Claims',
};

let fomcCache: CalEvent[] = [];
async function fomc() { fomcCache = await fetchFomcDates(); }

async function calendar() {
  const horizon = Date.now() + 8 * 86400e3;
  const fomcSoon = fomcCache.filter((e) => Date.parse(e.ts) > Date.now() - 86400e3 && Date.parse(e.ts) < horizon + 30 * 86400e3);
  try {
    const ff = await fetchForexFactory();
    const hasFomc = (e: CalEvent) => ff.some((x) => x.country === 'USD' && /FOMC|Federal Funds Rate/i.test(x.event) && Math.abs(Date.parse(x.ts) - Date.parse(e.ts)) < 6 * 3600e3);
    state.calendar = [...ff, ...fomcSoon.filter((e) => !hasFomc(e))].sort((a, b) => a.ts.localeCompare(b.ts));
    state.calendarSource = 'Forex Factory weekly (unofficial) + federalreserve.gov FOMC calendar';
  } catch (e) {
    // Fallback: official dates only. No consensus forecasts exist in official sources → shown as "—".
    const out: CalEvent[] = [...fomcSoon];
    if (config.keys.fred) {
      const rel = await fredReleaseDates();
      for (const r of rel) {
        const name = FRED_KEY_RELEASES[r.releaseId];
        if (!name) continue;
        out.push({ ts: new Date(r.date + 'T04:00:00Z').toISOString(), country: 'USD', event: `${name} (official date; time not provided)`, impact: 'high', forecast: null, previous: null, actual: null, source: 'FRED release calendar' });
      }
    }
    state.calendar = out.sort((a, b) => a.ts.localeCompare(b.ts));
    state.calendarSource = config.keys.fred ? 'Fallback: FOMC calendar + FRED release dates' : 'Fallback: FOMC calendar only (add FRED_API_KEY for data-release dates)';
    throw e;
  } finally {
    state.calendarFetchedAt = now();
  }
}

// ---------------- scheduler ----------------

export function startJobs(onRecompute: () => void) {
  const S = 1000, M = 60 * S, H = 60 * M;
  every('spot', 15 * S, spotTick);
  every('bidask', 15 * S, bidAskTick, 2 * S);
  every('silver', 60 * S, silverTick, 4 * S);
  every('btc', 60 * S, btcTick, 5 * S);
  every('sparkLive', 5 * M, sparkLive, 1 * S);
  every('sparkDaily', 3 * H, sparkDaily, 3 * S);
  every('futuresBackfill', 24 * H, futuresBackfill, 0);
  every('futures1m', 2 * M, futures1m, 90 * S);
  every('futuresRefresh', 30 * M, futuresRefresh, 10 * M);
  every('spotBackfill', 24 * H, spotBackfill, 2 * S);
  every('spot1m', 3 * M, spot1m, 3 * M);
  every('spotRefreshHigher', 6 * H, spotRefreshHigher, 6 * H);
  every('stooq', 6 * H, stooq, 6 * S);
  every('treasury', 1 * H, treasury, 1 * S);
  every('nyfed', 6 * H, nyfed, 7 * S);
  every('cpi', 24 * H, cpi, 8 * S);
  every('cftc', 6 * H, cftc, 9 * S);
  every('gld', 6 * H, gld, 10 * S);
  every('gpr', 12 * H, gpr, 11 * S);
  RSS_FEEDS.forEach((f, i) => every(`rss:${f.id}`, 5 * M, async () => ingestNews(await fetchRss(f), f.name), (12 + i * 3) * S));
  every('gdelt', 10 * M, async () => ingestNews(await fetchGdelt(), 'GDELT'), 40 * S);
  if (config.keys.finnhub) every('finnhub', 2 * M, async () => ingestNews(await fetchFinnhub(), 'Finnhub'), 45 * S);
  every('fomc', 24 * H, fomc, 13 * S);
  every('calendar', 30 * M, calendar, 20 * S);
  every('recompute', 30 * S, async () => onRecompute(), 25 * S);
}
