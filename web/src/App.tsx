import { useEffect, useState } from 'react';
import { loadPref, savePref, usePoll, useEventBump, useStream } from './api';
import { Calendar, type CalendarResp } from './components/Calendar';
import { FactorMonitor, type Factor } from './components/FactorMonitor';
import { GoldChart } from './components/GoldChart';
import { Header, type QuoteResp, type StatusResp } from './components/Header';
import { NewsFeed, type NewsItem } from './components/NewsFeed';
import { Performance } from './components/Performance';
import { Ranges, type RangesResp } from './components/Ranges';
import { SignalBoard, type SignalsResp } from './components/SignalBoard';

export function App() {
  const [theme, setThemeState] = useState<string>(() => loadPref('theme', 'dark'));
  const setTheme = (t: string) => { setThemeState(t); savePref('theme', t); };
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  // Chart canvas colours are read from CSS; re-create on OS scheme change when following the system.
  const [osScheme, setOs] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: light)');
    const h = () => setOs(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  const themeKey = theme === 'system' ? `system-${osScheme}` : theme;

  const [showPerf, setShowPerf] = useState(false);
  const quote = usePoll<QuoteResp>('quote', 15_000);
  const [liveQuote, setLiveQuote] = useState<QuoteResp | null>(null);
  useEffect(() => setLiveQuote(quote.data), [quote.data]);
  useStream('quote', (d) => {
    setLiveQuote((q) => (q && d?.spot ? { ...q, spot: q.spot ? { ...q.spot, price: d.spot.value, ts: d.spot.ts, status: 'live', change: q.spot.prevClose ? d.spot.value - q.spot.prevClose.value : null, changePct: q.spot.prevClose ? (d.spot.value / q.spot.prevClose.value - 1) * 100 : null } : q.spot } : q));
  });
  const status = usePoll<StatusResp>('status', 60_000);
  const candleBump = useEventBump('candles');
  const signals = usePoll<SignalsResp>('signals', 30_000, candleBump);
  const ranges = usePoll<RangesResp>('ranges', 60_000, candleBump);
  const factors = usePoll<{ factors: Factor[] }>('factors', 60_000, useEventBump('quotes'));
  const news = usePoll<{ items: NewsItem[] }>('news', 60_000, useEventBump('news'));
  const calendar = usePoll<CalendarResp>('calendar?days=7', 5 * 60_000);

  const instruments = status.data?.instruments ?? [];
  return (
    <div className="app">
      <Header quote={liveQuote} status={status.data} theme={theme} setTheme={setTheme} onPerf={() => setShowPerf(true)} />
      <div className="disclaimer" role="note">
        <strong>Not financial advice.</strong> For information and education only. Signals and ranges are probabilistic estimates computed from real public data and can be wrong.
      </div>
      <div className="main-grid">
        <div className="area-factors"><FactorMonitor factors={factors.data?.factors ?? null} error={factors.error} /></div>
        <div className="area-chart">
          <GoldChart
            key={themeKey}
            theme={themeKey}
            instruments={instruments}
            defaultInstrument={status.data?.analysisInstrument ?? instruments[0]?.id ?? null}
            ranges={ranges.data?.bands ?? []}
            calendar={calendar.data?.events ?? []}
            news={news.data?.items ?? []}
          />
        </div>
        <div className="area-signals">
          <SignalBoard data={signals.data} error={signals.error} />
          <Ranges data={ranges.data} price={signals.data?.cards[0]?.price ?? null} />
        </div>
      </div>
      <div className="bottom-grid">
        <NewsFeed items={news.data?.items ?? null} error={news.error} />
        <Calendar data={calendar.data} error={calendar.error} />
      </div>
      <footer className="footer">
        <div><strong className="secondary">Not financial advice.</strong> Information and education only. All data is real, from free public sources; computed values are labelled.</div>
        <div>
          Data: gold-api.com · Swissquote public quotes · Yahoo Finance (unofficial) · Twelve Data · Stooq · U.S. Treasury · Federal Reserve Bank of New York · Federal Reserve ·
          {' '}CFTC · SPDR Gold Shares · Caldara &amp; Iacoviello GPR index · BLS · FRED · Coinbase · GDELT · Google News · Investing.com · BBC · ECB · Finnhub · Forex Factory. Charts: TradingView Lightweight Charts™.
        </div>
      </footer>
      {showPerf && <Performance onClose={() => setShowPerf(false)} ranges={ranges.data?.bands ?? []} />}
    </div>
  );
}
