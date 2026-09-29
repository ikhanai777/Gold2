import { useEffect, useRef, useState } from 'react';
import { useStreamConnected } from '../api';
import { fmt, fmtSigned, Fresh, timeAgo, type Freshness } from '../ui';

export interface QuoteResp {
  market: { open: boolean; session: string; nextChange: string };
  spot: null | { price: number; source: string; ts: string; status: Freshness; change: number | null; changePct: number | null; prevClose: { value: number; date: string; source: string } | null };
  bidAsk: null | { bid: number; ask: number; source: string; ts: string; status: Freshness };
  futures: null | { price: number; previousClose: number | null; dayHigh: number | null; dayLow: number | null; change: number | null; changePct: number | null; basis: number | null; source: string; ts: string; status: Freshness };
}
interface Provider { provider: string; lastOk: string | null; lastError: string | null; lastErrorAt: string | null; callsToday: number; cap: number }
export interface StatusResp { analysisInstrument: string | null; instruments: { id: string; name: string; note: string }[]; keys: Record<string, boolean>; providers: Provider[] }

function StatusDialog({ status, onClose }: { status: StatusResp; onClose: () => void }) {
  return (
    <div className="overlay modal-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Data source status">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 style={{ margin: 0 }}>Data sources</h3><span className="spacer" /><button className="btn" onClick={onClose}>Close</button></div>
        <p className="small secondary">
          All providers are free. Each is polled once by the backend with a daily cap below its free limit. Optional free keys:
          {' '}Twelve Data {status.keys.twelveData ? '✓' : '✗'} (spot candles), FRED {status.keys.fred ? '✓' : '✗'} (CPI, release calendar), Finnhub {status.keys.finnhub ? '✓' : '✗'} (headlines).
        </p>
        <table>
          <thead><tr><th>Provider</th><th>Last success</th><th>Last error</th><th className="num">Calls today / cap</th></tr></thead>
          <tbody>
            {status.providers.map((p) => (
              <tr key={p.provider}>
                <td className="row"><span className={`dot ${p.lastOk && (!p.lastErrorAt || p.lastOk > p.lastErrorAt) ? 'live' : p.lastOk ? 'delayed' : p.lastError ? 'stale' : 'unavailable'}`} />{p.provider}</td>
                <td>{p.lastOk ? timeAgo(p.lastOk) : p.callsToday ? '—' : 'not used'}</td>
                <td className="small secondary">{p.lastError ? `${p.lastError} (${timeAgo(p.lastErrorAt)})` : '—'}</td>
                <td className="num">{p.callsToday} / {p.cap}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Header({ quote, status, theme, setTheme, onPerf }: { quote: QuoteResp | null; status: StatusResp | null; theme: string; setTheme: (t: string) => void; onPerf: () => void }) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState('');
  const [showStatus, setShowStatus] = useState(false);
  const connected = useStreamConnected();
  const p = quote?.spot?.price ?? null;
  useEffect(() => {
    if (p == null) return;
    if (prev.current != null && p !== prev.current) {
      setFlash(p > prev.current ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setFlash(''), 900);
      prev.current = p;
      return () => clearTimeout(t);
    }
    prev.current = p;
  }, [p]);
  const s = quote?.spot, f = quote?.futures;
  const failing = status?.providers.filter((x) => x.lastError && (!x.lastOk || (x.lastErrorAt ?? '') > x.lastOk)).length ?? 0;
  return (
    <header className="panel header">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><path d="M4 26h24l-4-9H8z" fill="var(--gold)" /><path d="M9 15h14l-3-7h-8z" fill="var(--gold-strong)" /></svg>
        Gold Signal Dashboard
      </div>
      <div className="price-block" aria-live="polite">
        <span className="small muted">XAU/USD spot</span>
        <span className={`price ${flash}`}>{s ? fmt(s.price) : '—'}</span>
        {s?.change != null ? (
          <span className={`mono ${s.change >= 0 ? 'bull' : 'bear'}`}>{s.change >= 0 ? '▲' : '▼'} {fmtSigned(s.change)} ({fmtSigned(s.changePct)}%)</span>
        ) : (
          <span className="tiny muted" title="Change needs a spot daily close from Stooq or Twelve Data; neither is available right now, so it is not estimated.">change vs prev close: —</span>
        )}
        {s && <Fresh status={s.status} ts={s.ts} source={s.source} />}
      </div>
      <div className="kv"><span className="k">Bid / Ask</span><span className="v">{quote?.bidAsk ? `${fmt(quote.bidAsk.bid)} / ${fmt(quote.bidAsk.ask)}` : '—'}</span></div>
      <div className="kv" title={f ? `${f.source} · as of ${f.ts}` : ''}>
        <span className="k">COMEX futures (GC=F)</span>
        <span className="v">{f ? <>{fmt(f.price)} <span className={f.change != null && f.change >= 0 ? 'bull' : 'bear'}>{fmtSigned(f.changePct)}%</span></> : '—'}</span>
      </div>
      <div className="kv"><span className="k">Futures day H / L</span><span className="v">{f?.dayHigh != null ? `${fmt(f.dayHigh)} / ${fmt(f.dayLow)}` : '—'}</span></div>
      <div className="kv" title="Futures price minus spot price (computed)"><span className="k">Basis</span><span className="v">{f?.basis != null ? fmtSigned(f.basis) : '—'}</span></div>
      <div className="kv"><span className="k">Session</span><span className="v">{quote ? <>{quote.market.open ? '●' : '○'} {quote.market.session}</> : '—'}</span><span className="tiny muted">{quote?.market.nextChange}</span></div>
      <div className="header-actions">
        <button className="btn" onClick={() => status && setShowStatus(true)} title="Data source health">
          <span className={`dot ${!connected ? 'stale' : failing ? 'delayed' : 'live'}`} /> {connected ? (failing ? `${failing} source${failing > 1 ? 's' : ''} failing` : 'Data OK') : 'Reconnecting…'}
        </button>
        <button className="btn" onClick={onPerf}>Performance</button>
        <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
        </select>
      </div>
      {showStatus && status && <StatusDialog status={status} onClose={() => setShowStatus(false)} />}
    </header>
  );
}
