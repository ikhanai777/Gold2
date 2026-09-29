// Gold & cross-asset price providers. All free: gold-api.com (no key),
// Swissquote public quote feed (no key, unofficial), Yahoo chart (no key,
// unofficial), Twelve Data (free key), Stooq CSV (no key), Coinbase (no key).
import { getJson, getText, ProviderError } from '../http.js';
import { config } from '../config.js';
import type { Candle } from '../types.js';

export interface SpotQuote { price: number; ts: string; source: string }

export async function goldApiSpot(symbol: 'XAU' | 'XAG'): Promise<SpotQuote> {
  const j = await getJson<{ price: number; updatedAt: string }>('gold-api', `https://api.gold-api.com/price/${symbol}`);
  if (typeof j.price !== 'number' || !(j.price > 0)) throw new ProviderError('gold-api', 'no price in response');
  return { price: j.price, ts: new Date(j.updatedAt).toISOString(), source: 'gold-api.com' };
}

export interface BidAsk { bid: number; ask: number; ts: string; source: string }

export async function swissquoteBidAsk(): Promise<BidAsk> {
  const j = await getJson<any[]>('swissquote', 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD');
  // Use the widest-distribution "prime" profile of the first platform that reports it.
  for (const p of j ?? []) {
    const prof = (p.spreadProfilePrices ?? []).find((s: any) => s.spreadProfile === 'prime') ?? p.spreadProfilePrices?.[0];
    if (prof && prof.bid > 0 && prof.ask > 0) {
      return { bid: prof.bid, ask: prof.ask, ts: new Date(p.ts).toISOString(), source: 'Swissquote public quotes (prime)' };
    }
  }
  throw new ProviderError('swissquote', 'no bid/ask in response');
}

export interface YahooChart {
  symbol: string;
  candles: Candle[];
  price: number | null;
  priceTime: string | null;
  previousClose: number | null;
  instrumentType: string;
}

export async function yahooChart(symbol: string, interval: string, range: string): Promise<YahooChart> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const j = await getJson<any>('yahoo', url);
  const r = j?.chart?.result?.[0];
  if (!r) throw new ProviderError('yahoo', j?.chart?.error?.description ?? 'no result');
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], hi = q.high?.[i], lo = q.low?.[i], c = q.close?.[i];
    // Skip bars the provider left empty; never fill them (SPEC §1.4).
    if (o == null || hi == null || lo == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: hi, low: lo, close: c, volume: q.volume?.[i] ?? undefined });
  }
  const m = r.meta ?? {};
  return {
    symbol,
    candles,
    price: m.regularMarketPrice ?? null,
    priceTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    previousClose: m.chartPreviousClose ?? m.previousClose ?? null,
    instrumentType: m.instrumentType ?? '',
  };
}

export interface SparkSeries {
  symbol: string;
  price: number | null;
  priceTime: string | null;
  previousClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  points: { time: number; close: number }[];
}

/** Batched quotes + closes for up to ~10 symbols in one call (Yahoo spark, unofficial). */
export async function yahooSpark(symbols: string[], range: string, interval: string): Promise<Map<string, SparkSeries>> {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(',')}&range=${range}&interval=${interval}`;
  const j = await getJson<any>('yahoo', url, { timeoutMs: 30000 });
  const out = new Map<string, SparkSeries>();
  for (const r of j?.spark?.result ?? []) {
    const resp = r.response?.[0];
    if (!resp) continue;
    const m = resp.meta ?? {};
    const ts: number[] = resp.timestamp ?? [];
    const cl: (number | null)[] = resp.indicators?.quote?.[0]?.close ?? [];
    const points: SparkSeries['points'] = [];
    ts.forEach((t, i) => { if (cl[i] != null && Number.isFinite(cl[i])) points.push({ time: t, close: cl[i] as number }); });
    out.set(r.symbol, {
      symbol: r.symbol,
      price: m.regularMarketPrice ?? null,
      priceTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      previousClose: m.previousClose ?? m.chartPreviousClose ?? null,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      points,
    });
  }
  if (!out.size) throw new ProviderError('yahoo', 'spark returned no results');
  return out;
}

const TD_INTERVAL: Record<string, string> = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' };

export async function twelveDataSeries(tf: string, outputsize: number): Promise<Candle[]> {
  if (!config.keys.twelveData) throw new ProviderError('twelvedata', 'no TWELVEDATA_API_KEY configured');
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${TD_INTERVAL[tf]}&outputsize=${outputsize}&timezone=UTC&order=ASC&apikey=${config.keys.twelveData}`;
  const j = await getJson<any>('twelvedata', url);
  if (j.status !== 'ok' || !Array.isArray(j.values)) throw new ProviderError('twelvedata', j.message ?? 'bad response');
  return j.values.map((v: any) => ({
    time: Math.floor(Date.parse(v.datetime.replace(' ', 'T') + 'Z') / 1000),
    open: +v.open, high: +v.high, low: +v.low, close: +v.close,
  }));
}

export async function stooqDaily(): Promise<Candle[]> {
  const csv = await getText('stooq', 'https://stooq.com/q/d/l/?s=xauusd&i=d', { timeoutMs: 30000 });
  const lines = csv.trim().split('\n');
  if (!/^Date,Open,High,Low,Close/i.test(lines[0] ?? '')) throw new ProviderError('stooq', `unexpected response: ${lines[0]?.slice(0, 80)}`);
  const out: Candle[] = [];
  for (const l of lines.slice(1)) {
    const [d, o, hi, lo, c] = l.split(',');
    const t = Date.parse(d + 'T00:00:00Z') / 1000;
    if (!Number.isFinite(t) || !(+c > 0)) continue;
    out.push({ time: t, open: +o, high: +hi, low: +lo, close: +c });
  }
  return out;
}

export async function coinbaseBtc(): Promise<SpotQuote> {
  const j = await getJson<any>('coinbase', 'https://api.exchange.coinbase.com/products/BTC-USD/ticker');
  if (!(+j.price > 0)) throw new ProviderError('coinbase', 'no price');
  return { price: +j.price, ts: new Date(j.time).toISOString(), source: 'Coinbase Exchange' };
}
