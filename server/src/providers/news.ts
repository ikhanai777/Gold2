// News & calendar providers — all $0: GDELT DOC 2.0 (no key), public RSS feeds
// (Google News search, Yahoo Finance, Investing.com, BBC World, Federal Reserve,
// ECB), Finnhub (free key, optional), Forex Factory weekly JSON (unofficial),
// Federal Reserve FOMC calendar page.
import { XMLParser } from 'fast-xml-parser';
import { getJson, getText, ProviderError } from '../http.js';
import { config } from '../config.js';

export interface RawNews { title: string; url: string; source: string; feed: string; ts: string; snippet: string; tone?: number }

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true });

const stripHtml = (s: unknown) =>
  String(typeof s === 'object' && s && '#text' in (s as any) ? (s as any)['#text'] : s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const RSS_FEEDS: { id: string; name: string; url: string }[] = [
  {
    id: 'gnews',
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('(gold price OR bullion OR "Federal Reserve" OR inflation OR "central bank" OR geopolitical OR tariffs) when:2d') +
      '&hl=en-US&gl=US&ceid=US:en',
  },
  { id: 'yahoo', name: 'Yahoo Finance (GC=F)', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=GC=F&region=US&lang=en-US' },
  { id: 'investing', name: 'Investing.com Commodities', url: 'https://www.investing.com/rss/news_11.rss' },
  { id: 'bbc', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { id: 'ecb', name: 'ECB', url: 'https://www.ecb.europa.eu/rss/press.html' },
];

export async function fetchRss(feed: (typeof RSS_FEEDS)[number]): Promise<RawNews[]> {
  // Each feed has its own backoff, so one feed's rate limit never pauses the others.
  const text = await getText(`rss:${feed.id}`, feed.url);
  const doc = xml.parse(text);
  let items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  if (!Array.isArray(items)) items = [items];
  const out: RawNews[] = [];
  for (const it of items) {
    const title = stripHtml(it.title);
    const link = typeof it.link === 'string' ? it.link : it.link?.['@href'] ?? it.guid?.['#text'] ?? it.guid;
    const date = it.pubDate ?? it.updated ?? it['dc:date'];
    const ts = date ? new Date(date) : null;
    if (!title || !link || !ts || Number.isNaN(ts.getTime())) continue; // no invented timestamps
    let source = feed.name;
    if (feed.id === 'gnews') source = stripHtml(it.source) || 'Google News';
    out.push({ title, url: String(link), source, feed: feed.name, ts: ts.toISOString(), snippet: stripHtml(it.description).slice(0, 280) });
  }
  return out;
}

export async function fetchGdelt(): Promise<RawNews[]> {
  const q = encodeURIComponent('(gold OR "Federal Reserve" OR inflation OR "central bank" OR sanctions OR war OR tariff) sourcelang:english');
  const j = await getJson<any>('gdelt', `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=75&sort=datedesc&timespan=24h`);
  return (j.articles ?? []).map((a: any) => {
    const s = String(a.seendate ?? ''); // 20260929T201500Z
    const ts = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
    return { title: a.title, url: a.url, source: a.domain, feed: 'GDELT', ts, snippet: '', tone: typeof a.tone === 'number' ? a.tone : undefined };
  }).filter((n: RawNews) => n.title && !Number.isNaN(Date.parse(n.ts)));
}

export async function fetchFinnhub(): Promise<RawNews[]> {
  if (!config.keys.finnhub) throw new ProviderError('finnhub', 'no FINNHUB_API_KEY configured');
  const out: RawNews[] = [];
  for (const cat of ['general', 'forex']) {
    const arr = await getJson<any[]>('finnhub', `https://finnhub.io/api/v1/news?category=${cat}&token=${config.keys.finnhub}`);
    for (const a of arr ?? []) {
      if (!a.headline || !a.datetime) continue;
      out.push({ title: a.headline, url: a.url, source: a.source, feed: 'Finnhub', ts: new Date(a.datetime * 1000).toISOString(), snippet: String(a.summary ?? '').slice(0, 280) });
    }
  }
  return out;
}

export interface CalEvent {
  ts: string; country: string; event: string; impact: 'low' | 'medium' | 'high' | 'holiday';
  forecast: string | null; previous: string | null; actual: string | null; source: string;
}

export async function fetchForexFactory(): Promise<CalEvent[]> {
  const arr = await getJson<any[]>('forexfactory', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json');
  return arr.map((e) => ({
    ts: new Date(e.date).toISOString(),
    country: e.country,
    event: e.title,
    impact: (String(e.impact).toLowerCase() as CalEvent['impact']) ?? 'low',
    forecast: e.forecast || null,
    previous: e.previous || null,
    actual: e.actual || null,
    source: 'Forex Factory (unofficial)',
  }));
}

const MONTH_IDX: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Convert a New York wall-clock time to a UTC Date. */
export function nyToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asNy = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess + (guess - asNy));
}

/** FOMC statement times (2:00pm ET on the final meeting day) from federalreserve.gov. */
export async function fetchFomcDates(): Promise<CalEvent[]> {
  const html = await getText('fomc', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
  const out: CalEvent[] = [];
  const panels = html.split(/<h4><a id="\d+">(\d{4}) FOMC Meetings<\/a><\/h4>/);
  for (let i = 1; i < panels.length; i += 2) {
    const year = +panels[i];
    const body = panels[i + 1];
    const re = /fomc-meeting__month[^>]*><strong>([^<]+)<\/strong><\/div>\s*<div[^>]*fomc-meeting__date[^>]*>([^<]+)<\/div>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const months = m[1].split('/').map((s) => MONTH_IDX[s.trim().toLowerCase()]);
      const days = m[2].replace(/[*]/g, '').trim().split('-').map((s) => parseInt(s, 10));
      const lastDay = days[days.length - 1];
      const month = months[months.length - 1];
      if (!month || !Number.isFinite(lastDay)) continue; // e.g. notation-vote rows
      out.push({
        ts: nyToUtc(year, month, lastDay, 14, 0).toISOString(),
        country: 'USD',
        event: 'FOMC Statement & Rate Decision',
        impact: 'high',
        forecast: null, previous: null, actual: null,
        source: 'federalreserve.gov FOMC calendar',
      });
    }
  }
  return out;
}
