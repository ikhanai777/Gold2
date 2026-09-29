// Macro & positioning providers. Keyless official sources first:
// US Treasury (yield curves), NY Fed (EFFR/target), CFTC (COT), SPDR (GLD
// holdings), Caldara-Iacoviello GPR index. FRED/BLS are used when available.
import * as XLSX from 'xlsx';
import { getBuffer, getJson, getText, ProviderError } from '../http.js';
import { config } from '../config.js';
import type { SeriesPoint } from '../types.js';

const mdy = (s: string) => {
  const [m, d, y] = s.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

/** Daily Treasury par yield curve ("nominal") or real yield curve, for the given years. */
export async function treasuryCurve(kind: 'nominal' | 'real', years: number[]): Promise<Record<string, SeriesPoint[]>> {
  const type = kind === 'nominal' ? 'daily_treasury_yield_curve' : 'daily_treasury_real_yield_curve';
  const cols: Record<string, SeriesPoint[]> = {};
  for (const y of years) {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=${type}&field_tdr_date_value=${y}&page&_format=csv`;
    const csv = await getText('treasury', url, { timeoutMs: 30000 });
    const lines = csv.trim().split('\n');
    const header = lines[0].split(',').map((h) => h.replace(/"/g, '').trim());
    if (header[0] !== 'Date') throw new ProviderError('treasury', 'unexpected CSV header');
    for (const l of lines.slice(1)) {
      const parts = l.split(',');
      const date = mdy(parts[0]);
      header.slice(1).forEach((h, i) => {
        const v = parseFloat(parts[i + 1]);
        if (Number.isFinite(v)) (cols[h] ??= []).push({ date, value: v });
      });
    }
  }
  for (const k of Object.keys(cols)) cols[k].sort((a, b) => a.date.localeCompare(b.date));
  return cols;
}

export interface FedRate { effr: number; targetFrom: number; targetTo: number; date: string }
export async function nyFedEffr(): Promise<FedRate> {
  const j = await getJson<any>('nyfed', 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json');
  const r = j?.refRates?.[0];
  if (!r) throw new ProviderError('nyfed', 'no data');
  return { effr: r.percentRate, targetFrom: r.targetRateFrom, targetTo: r.targetRateTo, date: r.effectiveDate };
}

export interface CotWeek { date: string; mmLong: number; mmShort: number; net: number; openInterest: number }
/** CFTC Disaggregated Futures-Only report, Gold (COMEX), market code 088691. */
export async function cftcGold(weeks = 260): Promise<CotWeek[]> {
  const url =
    'https://publicreporting.cftc.gov/resource/72hh-3qpy.json?cftc_contract_market_code=088691' +
    `&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}` +
    '&$select=report_date_as_yyyy_mm_dd,m_money_positions_long_all,m_money_positions_short_all,open_interest_all';
  const rows = await getJson<any[]>('cftc', url, { timeoutMs: 30000 });
  return rows
    .map((r) => {
      const mmLong = +r.m_money_positions_long_all, mmShort = +r.m_money_positions_short_all;
      return { date: r.report_date_as_yyyy_mm_dd.slice(0, 10), mmLong, mmShort, net: mmLong - mmShort, openInterest: +r.open_interest_all };
    })
    .filter((r) => Number.isFinite(r.net))
    .reverse();
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

/** GLD tonnes of gold held, from the SPDR historical archive (xlsx). */
export async function gldHoldings(): Promise<SeriesPoint[]> {
  const buf = await getBuffer('gld', 'https://api.spdrgoldshares.com/api/v1/historical-archive?product=gld&exchange=NYSE&lang=en');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames.find((n) => /archive/i.test(n)) ?? wb.SheetNames[wb.SheetNames.length - 1]];
  const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: true });
  const hdr = (rows[0] ?? []).map(String);
  const iDate = hdr.findIndex((x) => /^date$/i.test(x));
  const iT = hdr.findIndex((x) => /tonnes/i.test(x));
  if (iDate < 0 || iT < 0) throw new ProviderError('gld', 'unexpected sheet layout');
  const out: SeriesPoint[] = [];
  for (const r of rows.slice(1)) {
    const m = String(r[iDate] ?? '').match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    const v = Number(r[iT]);
    if (!m || !Number.isFinite(v) || v <= 0) continue; // holidays are text rows; skip them
    out.push({ date: `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`, value: v });
  }
  return out;
}

/** Caldara & Iacoviello daily Geopolitical Risk index (GPRD). */
export async function gprDaily(): Promise<SeriesPoint[]> {
  const buf = await getBuffer('gpr', 'https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const hdr = (rows[0] ?? []).map(String);
  const iDay = hdr.indexOf('DAY'), iG = hdr.indexOf('GPRD');
  if (iDay < 0 || iG < 0) throw new ProviderError('gpr', 'unexpected sheet layout');
  const out: SeriesPoint[] = [];
  for (const r of rows.slice(1)) {
    const d = String(r[iDay] ?? '');
    const v = Number(r[iG]);
    if (!/^\d{8}$/.test(d) || !Number.isFinite(v)) continue;
    out.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, value: v });
  }
  return out;
}

/** US CPI-U (not seasonally adjusted) via BLS public API v1 (no key, small daily quota). */
export async function blsCpi(): Promise<SeriesPoint[]> {
  const j = await getJson<any>('bls', 'https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0');
  if (j.status !== 'REQUEST_SUCCEEDED') throw new ProviderError('bls', (j.message ?? []).join(' ') || 'request failed');
  return (j.Results.series[0].data as any[])
    .filter((d) => /^M\d\d$/.test(d.period) && d.period !== 'M13')
    .map((d) => ({ date: `${d.year}-${d.period.slice(1)}-01`, value: +d.value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** FRED series (requires a free FRED_API_KEY). */
export async function fredSeries(id: string, start = '2015-01-01'): Promise<SeriesPoint[]> {
  if (!config.keys.fred) throw new ProviderError('fred', 'no FRED_API_KEY configured');
  const j = await getJson<any>(
    'fred',
    `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${config.keys.fred}&file_type=json&observation_start=${start}`,
  );
  return (j.observations ?? []).filter((o: any) => o.value !== '.').map((o: any) => ({ date: o.date, value: +o.value }));
}

export interface ReleaseDate { releaseId: number; name: string; date: string }
/** Official scheduled release dates (incl. future ones) from FRED. */
export async function fredReleaseDates(): Promise<ReleaseDate[]> {
  if (!config.keys.fred) throw new ProviderError('fred', 'no FRED_API_KEY configured');
  const from = new Date().toISOString().slice(0, 10);
  const j = await getJson<any>(
    'fred',
    `https://api.stlouisfed.org/fred/releases/dates?api_key=${config.keys.fred}&file_type=json&realtime_start=${from}&include_release_dates_with_no_data=true&sort_order=asc&limit=1000`,
  );
  return (j.release_dates ?? []).map((r: any) => ({ releaseId: r.release_id, name: r.release_name, date: r.date }));
}
