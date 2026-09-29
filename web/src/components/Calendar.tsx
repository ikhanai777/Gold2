import { useEffect, useState } from 'react';
import { Info, Panel, timeUntil } from '../ui';

export interface CalEvent { ts: string; country: string; event: string; impact: string; forecast: string | null; previous: string | null; actual: string | null; source: string }
export interface CalendarResp { source: string; fetchedAt: string | null; events: CalEvent[] }

export function Calendar({ data, error }: { data: CalendarResp | null; error: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(id); }, []);
  const [onlyUsdHigh, setOnly] = useState(false);
  const events = (data?.events ?? []).filter((e) => !onlyUsdHigh || (e.impact === 'high' && e.country === 'USD'));
  const next = (data?.events ?? []).find((e) => e.impact === 'high' && Date.parse(e.ts) > Date.now());
  const byDay = new Map<string, CalEvent[]>();
  for (const e of events) {
    const k = new Date(e.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e);
  }
  return (
    <Panel title="Economic calendar" right={<Info text={`Source: ${data?.source ?? '—'}. Forecasts come only from the source; official fallback sources have no consensus forecasts, so they show “—”. Actuals appear only if the source provides them.`} />}>
      <div className="chart-toolbar">
        {next ? <span className="small">Next high-impact: <strong>{next.country} {next.event}</strong> in <span className="mono">{timeUntil(next.ts)}</span></span> : <span className="small muted">No upcoming high-impact event loaded</span>}
        <span className="spacer" />
        <label className="chip"><input type="checkbox" checked={onlyUsdHigh} onChange={(e) => setOnly(e.target.checked)} /> USD high only</label>
      </div>
      <div className="news-list" style={{ maxHeight: 520 }}>
        {!data && <div className="empty">{error ?? 'Loading calendar…'}</div>}
        {data && !events.length && <div className="empty">No events in the next 7 days from {data.source || 'the calendar sources'}.</div>}
        {events.length > 0 && (
          <div className="cal-row tiny muted" style={{ fontWeight: 600 }}>
            <span>Time</span><span>Ccy</span><span>Event</span><span className="num">Actual</span><span className="num hide-sm">Forecast</span><span className="num hide-sm">Previous</span>
          </div>
        )}
        {[...byDay].map(([day, evs]) => (
          <div key={day}>
            <div className="cal-day">{day}</div>
            {evs.map((e, i) => {
              const dateOnly = /time not provided/.test(e.event);
              return (
                <div key={i} className={`cal-row ${e.impact === 'high' ? 'high' : ''} ${Date.parse(e.ts) < Date.now() ? 'past' : ''}`} title={e.source}>
                  <span className="mono">{dateOnly ? 'TBA' : new Date(e.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                  <span>{e.country}</span>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <span className={`impact-pill ${e.impact}`}>{e.impact === 'holiday' ? 'hol' : e.impact.slice(0, 3)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.event}</span>
                  </span>
                  <span className="mono num">{e.actual ?? '—'}</span>
                  <span className="mono num hide-sm">{e.forecast ?? '—'}</span>
                  <span className="mono num hide-sm">{e.previous ?? '—'}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}
