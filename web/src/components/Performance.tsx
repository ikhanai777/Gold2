import { usePoll } from '../api';
import { fmt, fmtDateTime } from '../ui';
import type { Band } from './Ranges';

interface Backtest {
  horizon: string; bars: string; forward: string; from: string; to: string; samples: number; factorsUsed: string[];
  byLabel: { label: string; count: number; avgFwdReturn: number; hitRate: number | null }[];
  directionalHitRate: number | null;
  strategy: { totalReturn: number; maxDrawdown: number; exposure: number };
  buyHold: { totalReturn: number; maxDrawdown: number };
  equity: { time: number; strategy: number; buyHold: number }[];
}
interface PerfResp {
  ts: string | null; instrument: string | null; backtests: Backtest[]; note: string;
  forward: { ranges: { period: string; periodStart: string; low: number; high: number; close: number; inside: boolean }[]; signals: any[]; since: string };
}

const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);

function EquityChart({ data }: { data: Backtest['equity'] }) {
  if (data.length < 2) return null;
  const w = 520, h = 150, pad = { l: 44, r: 118, t: 8, b: 20 };
  const vals = data.flatMap((d) => [d.strategy, d.buyHold]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i: number) => pad.l + (i / (data.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min || 1)) * (h - pad.t - pad.b);
  const path = (k: 'strategy' | 'buyHold') => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join('');
  const last = data[data.length - 1];
  const ticks = [min, (min + max) / 2, max];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w }} role="img" aria-label={`Equity curve: strategy ${fmt(last.strategy)}x vs buy and hold ${fmt(last.buyHold)}x`}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">{t.toFixed(2)}×</text>
        </g>
      ))}
      <path d={path('buyHold')} fill="none" stroke="var(--s2)" strokeWidth={2} />
      <path d={path('strategy')} fill="none" stroke="var(--s1)" strokeWidth={2} />
      <text x={w - pad.r + 6} y={y(last.strategy) + 3} fontSize="11" fill="var(--text-primary)">Signal {last.strategy.toFixed(2)}×</text>
      <text x={w - pad.r + 6} y={y(last.buyHold) + 14 * (Math.abs(y(last.buyHold) - y(last.strategy)) < 12 ? 1 : 0) + 3} fontSize="11" fill="var(--text-secondary)">Buy&amp;hold {last.buyHold.toFixed(2)}×</text>
      <text x={pad.l} y={h - 4} fontSize="10" fill="var(--text-muted)">{new Date(data[0].time * 1000).toISOString().slice(0, 10)}</text>
      <text x={w - pad.r} y={h - 4} fontSize="10" textAnchor="end" fill="var(--text-muted)">{new Date(last.time * 1000).toISOString().slice(0, 10)}</text>
    </svg>
  );
}

export function Performance({ onClose, ranges }: { onClose: () => void; ranges: Band[] }) {
  const { data, error } = usePoll<PerfResp>('performance', 60_000);
  const fwdR = data?.forward.ranges ?? [];
  return (
    <div className="overlay modal-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Performance and transparency">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 style={{ margin: 0 }}>Performance &amp; transparency</h2><span className="spacer" /><button className="btn" onClick={onClose}>Close</button></div>
        <p className="small secondary">
          Walk-forward backtests on real history ({data?.instrument === 'GC=F' ? 'COMEX gold futures via Yahoo' : data?.instrument ?? '—'}). At each bar only data available at that time is used
          (macro series strictly before the bar's date; CFTC only after its Friday release). News sentiment has no history and is excluded from backtests.
          {' '}{data?.note} {data?.ts && `Last run ${fmtDateTime(data.ts)}.`}
        </p>
        {error && <p className="bear">{error}</p>}
        {!data?.backtests.length && <div className="empty">Backtest runs once enough history has loaded (usually within a minute of start-up).</div>}
        {data?.backtests.map((b) => (
          <section key={b.horizon} style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 4 }}>{b.horizon[0].toUpperCase() + b.horizon.slice(1)} <span className="small muted">— {b.bars}, forward return over {b.forward}, {b.from} → {b.to}, {b.samples.toLocaleString()} samples</span></h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
              <table>
                <thead><tr><th>Label</th><th className="num">Count</th><th className="num">Avg fwd return</th><th className="num">Hit rate</th></tr></thead>
                <tbody>
                  {b.byLabel.map((l) => (
                    <tr key={l.label}><td>{l.label}</td><td className="num">{l.count}</td><td className={`num ${l.avgFwdReturn > 0 ? 'bull' : l.avgFwdReturn < 0 ? 'bear' : ''}`}>{l.count ? pct(l.avgFwdReturn, 2) : '—'}</td><td className="num">{pct(l.hitRate)}</td></tr>
                  ))}
                  <tr><td colSpan={3}>Directional hit rate (Buy/Sell labels)</td><td className="num"><strong>{pct(b.directionalHitRate)}</strong></td></tr>
                  <tr><td colSpan={2}>Follow-the-signal (next bar, no costs)</td><td className="num">{pct(b.strategy.totalReturn)}</td><td className="num" title="max drawdown">DD {pct(b.strategy.maxDrawdown)}</td></tr>
                  <tr><td colSpan={2}>Buy &amp; hold</td><td className="num">{pct(b.buyHold.totalReturn)}</td><td className="num">DD {pct(b.buyHold.maxDrawdown)}</td></tr>
                  <tr><td colSpan={4} className="tiny muted">Exposure {pct(b.strategy.exposure, 0)} · factors: {b.factorsUsed.join(', ')}</td></tr>
                </tbody>
              </table>
              <div>
                <div className="row tiny muted"><span className="swatch" style={{ background: 'var(--s1)' }} /> Signal strategy <span className="swatch" style={{ background: 'var(--s2)' }} /> Buy &amp; hold</div>
                <EquityChart data={b.equity} />
              </div>
            </div>
          </section>
        ))}
        <h3>Range calibration (out-of-sample, historical)</h3>
        <table>
          <thead><tr><th>Period</th><th className="num">Inside 68% band</th><th className="num">Inside 95% band</th><th className="num">Periods</th><th>Method</th></tr></thead>
          <tbody>{ranges.map((r) => <tr key={r.period}><td>{r.period}</td><td className="num">{pct(r.hitRate68)}</td><td className="num">{pct(r.hitRate95)}</td><td className="num">{r.samples}</td><td className="small">{r.method}</td></tr>)}</tbody>
        </table>
        <h3>Live forward tracking <span className="small muted">since {fmtDateTime(data?.forward.since)}</span></h3>
        <p className="small secondary">Every published range and signal is logged. Completed range periods: {fwdR.length ? `${fwdR.filter((r) => r.inside).length}/${fwdR.length} closed inside the expected band` : 'none completed yet'}.</p>
        {fwdR.length > 0 && (
          <table>
            <thead><tr><th>Period</th><th>Start</th><th className="num">Low</th><th className="num">High</th><th className="num">Close</th><th>Result</th></tr></thead>
            <tbody>{fwdR.slice(0, 30).map((r, i) => <tr key={i}><td>{r.period}</td><td>{fmtDateTime(r.periodStart)}</td><td className="num">{fmt(r.low)}</td><td className="num">{fmt(r.high)}</td><td className="num">{fmt(r.close)}</td><td>{r.inside ? '✓ inside' : '✗ outside'}</td></tr>)}</tbody>
          </table>
        )}
        <details style={{ marginTop: 12 }}>
          <summary className="small">Signal log ({data?.forward.signals.length ?? 0} entries)</summary>
          <table>
            <thead><tr><th>Time</th><th>Horizon</th><th>Label</th><th className="num">Score</th><th className="num">Price</th></tr></thead>
            <tbody>{(data?.forward.signals ?? []).slice(0, 100).map((s: any, i: number) => <tr key={i}><td>{fmtDateTime(s.ts)}</td><td>{s.horizon}</td><td>{s.label}</td><td className="num">{Math.round(s.score)}</td><td className="num">{fmt(s.price)}</td></tr>)}</tbody>
          </table>
        </details>
      </div>
    </div>
  );
}
