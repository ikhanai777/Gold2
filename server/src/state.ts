// In-memory state holding the latest real data from each provider, with
// provenance. Computed views are derived from this in analytics.ts.
import type { Candle, Freshness, SeriesPoint } from './types.js';
import type { CotWeek, FedRate } from './providers/macro.js';
import type { CalEvent } from './providers/news.js';
import type { Classified } from './engines/newsClassify.js';

export interface Sourced<T> { value: T; source: string; ts: string | null; fetchedAt: string }

export interface NewsItem extends Classified {
  id: string; title: string; url: string; source: string; feed: string; ts: string; snippet: string;
}

export type InstrumentId = 'XAUUSD' | 'GC=F';

export const INSTRUMENTS: Record<InstrumentId, { name: string; kind: string; note: string }> = {
  XAUUSD: { name: 'XAU/USD Spot', kind: 'spot', note: 'Spot gold (Twelve Data)' },
  'GC=F': { name: 'COMEX Gold Futures (GC=F)', kind: 'futures', note: 'COMEX front-month gold futures via Yahoo Finance — not spot' },
};

export const state = {
  startedAt: new Date().toISOString(),
  spot: null as Sourced<number> | null,
  bidAsk: null as Sourced<{ bid: number; ask: number }> | null,
  silver: null as Sourced<number> | null,
  btc: null as Sourced<number> | null,
  // live cross-asset quotes from Yahoo spark (5-min cadence)
  quotes: new Map<string, Sourced<{ price: number; previousClose: number | null; dayHigh: number | null; dayLow: number | null }>>(),
  // candles per instrument/timeframe (real provider bars + real aggregations)
  candles: new Map<string, { bars: Candle[]; source: string; fetchedAt: string }>(),
  formingSpot: null as (Candle & { ticks: number }) | null,
  // daily series with provenance
  series: new Map<string, { points: SeriesPoint[]; source: string; fetchedAt: string; unit: string }>(),
  fed: null as Sourced<FedRate> | null,
  cot: null as Sourced<CotWeek[]> | null,
  news: [] as NewsItem[],
  newsFetchedAt: new Map<string, string>(),
  calendar: [] as CalEvent[],
  calendarSource: '' as string,
  calendarFetchedAt: null as string | null,
  rejectedTicks: 0,
};

export const ckey = (inst: InstrumentId, tf: string) => `${inst}:${tf}`;

export function setCandles(inst: InstrumentId, tf: string, bars: Candle[], source: string) {
  state.candles.set(ckey(inst, tf), { bars, source, fetchedAt: new Date().toISOString() });
}
export function getCandles(inst: InstrumentId, tf: string) {
  return state.candles.get(ckey(inst, tf));
}

export function setSeries(id: string, points: SeriesPoint[], source: string, unit = '') {
  state.series.set(id, { points, source, fetchedAt: new Date().toISOString(), unit });
}

/** Freshness from the age of a timestamp versus the expected update interval. */
export function freshness(ts: string | null | undefined, expectedMs: number, marketClosed = false): Freshness {
  if (!ts) return 'unavailable';
  const age = Date.now() - Date.parse(ts);
  if (age <= 2 * expectedMs) return 'live';
  if (marketClosed) return 'delayed';
  if (age <= 6 * expectedMs) return 'delayed';
  return 'stale';
}

/** Gold trades ~Sun 18:00 → Fri 17:00 ET with a daily 17:00–18:00 ET break. */
export function marketStatus(now = new Date()): { open: boolean; session: string; nextChange: string } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const wd = p.weekday as string, h = +p.hour + +p.minute / 60;
  const closedWeekend = wd === 'Sat' || (wd === 'Fri' && h >= 17) || (wd === 'Sun' && h < 18);
  const dailyBreak = !closedWeekend && h >= 17 && h < 18;
  if (closedWeekend) return { open: false, session: 'Closed (weekend)', nextChange: 'Opens Sun 18:00 ET' };
  if (dailyBreak) return { open: false, session: 'Daily break', nextChange: 'Reopens 18:00 ET' };
  // Session by UTC hour: Asia 22–07, London 07–13, New York 13–22 (approx.)
  const uh = now.getUTCHours();
  const session = uh >= 22 || uh < 7 ? 'Asia' : uh < 13 ? 'London' : 'New York';
  return { open: true, session, nextChange: session === 'Asia' ? 'London opens 07:00 UTC' : session === 'London' ? 'New York opens 13:00 UTC' : 'Asia opens 22:00 UTC' };
}
