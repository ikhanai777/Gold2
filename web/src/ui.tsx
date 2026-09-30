import type { ReactNode } from 'react';

export type Freshness = 'live' | 'delayed' | 'stale' | 'unavailable';

export const fmt = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const fmtSigned = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), d)}`;

export function timeAgo(ts: string | null | undefined) {
  if (!ts) return '—';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 0) return 'in ' + timeUntil(ts);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function timeUntil(ts: string) {
  const s = Math.max(0, (Date.parse(ts) - Date.now()) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export const fmtDateTime = (ts: string | null | undefined) =>
  ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const STATUS_TEXT: Record<Freshness, string> = { live: 'Live', delayed: 'Delayed', stale: 'Stale', unavailable: 'Unavailable' };

export function Fresh({ status, ts, source }: { status: Freshness; ts?: string | null; source?: string }) {
  const title = `${STATUS_TEXT[status]}${source ? ` · ${source}` : ''}${ts ? ` · as of ${ts.length > 10 ? new Date(ts).toLocaleString() : ts}` : ''}`;
  return (
    <span className="badge" title={title}>
      <span className={`dot ${status}`} aria-hidden />
      {STATUS_TEXT[status]}
    </span>
  );
}

export const Computed = ({ title }: { title?: string }) => (
  <span className="badge computed" title={title ?? 'Computed from real source data (inputs listed in tooltip / drawer)'}>Computed</span>
);
export const Estimate = ({ title }: { title?: string }) => (
  <span className="badge estimate" title={title ?? 'Forecast estimate — probabilistic, not a reported value'}>Estimate</span>
);

export const Info = ({ text }: { text: string }) => (
  <span className="info" title={text} aria-label={text} role="img">i</span>
);

export function Panel({ title, right, children, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="spacer" />
        {right}
      </div>
      {children}
    </section>
  );
}

export function Arrow({ dir }: { dir: number }) {
  return <span aria-hidden>{dir > 0 ? '▲' : dir < 0 ? '▼' : '■'}</span>;
}

export function Sparkline({ points, w = 84, h = 26 }: { points: { value: number }[]; w?: number; h?: number }) {
  const v = (points ?? []).map((p) => p.value).filter((x) => Number.isFinite(x));
  if (v.length < 2) return <svg width={w} height={h} aria-hidden />;
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const x = (i: number) => (i / (v.length - 1)) * (w - 4) + 2;
  const y = (val: number) => h - 3 - ((val - min) / span) * (h - 6);
  const d = v.map((val, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`).join('');
  const up = v[v.length - 1] >= v[0];
  return (
    <svg width={w} height={h} role="img" aria-label={`30-point trend ${up ? 'up' : 'down'} from ${v[0]} to ${v[v.length - 1]}`}>
      <path d={d} fill="none" stroke="var(--text-secondary)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(v.length - 1)} cy={y(v[v.length - 1])} r={2.5} fill="var(--gold)" />
    </svg>
  );
}

export function labelClass(label: string) {
  return label.includes('BUY') ? 'buy' : label.includes('SELL') ? 'sell' : 'neutral';
}
