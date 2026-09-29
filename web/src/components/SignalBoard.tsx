import { useState } from 'react';
import { Computed, fmt, fmtDateTime, fmtSigned, Info, labelClass, Panel, timeAgo, timeUntil } from '../ui';

interface Zone { price: number; label: string; strength: number }
export interface SignalCard {
  horizon: 'intraday' | 'swing' | 'position'; tf: string; instrument: string; price: number;
  score: number; rawScore: number; label: string; confidence: 'Low' | 'Medium' | 'High'; agreement: number;
  contributions: { id: string; name: string; score: number; weight: number; contribution: number; detail: string }[];
  excluded: { id: string; name: string; reason: string }[];
  eventRisk: { event: string; ts: string } | null;
  levels: { support: Zone | null; resistance: Zone | null; atr: number; stopDistance: number };
  history: { ts: string; label: string; score: number }[];
  lastChange: string | null;
}
export interface SignalsResp { ts: string; instrument: string | null; cards: SignalCard[] }

const TITLES = { intraday: 'Intraday', swing: 'Swing', position: 'Position' };
const SUB = { intraday: '1H bars · hours to a day', swing: 'Daily bars · days to weeks', position: 'Weekly bars · weeks to months' };

function Gauge({ score, label }: { score: number; label: string }) {
  const w = 132, h = 74, r = 56, cx = w / 2, cy = 66;
  const a = Math.PI * (1 - (score + 100) / 200); // 180° (left, -100) → 0° (right, +100)
  const nx = cx + (r - 8) * Math.cos(a), ny = cy - (r - 8) * Math.sin(a);
  const arc = (from: number, to: number) => {
    const a1 = Math.PI * (1 - (from + 100) / 200), a2 = Math.PI * (1 - (to + 100) / 200);
    return `M${cx + r * Math.cos(a1)},${cy - r * Math.sin(a1)} A${r},${r} 0 0 1 ${cx + r * Math.cos(a2)},${cy - r * Math.sin(a2)}`;
  };
  return (
    <svg width={w} height={h} role="img" aria-label={`Score ${Math.round(score)} of −100 to +100: ${label}`}>
      <path d={arc(-100, -60)} stroke="var(--bear)" strokeWidth={8} fill="none" />
      <path d={arc(-58, -20)} stroke="var(--bear)" strokeOpacity={0.45} strokeWidth={8} fill="none" />
      <path d={arc(-18, 18)} stroke="var(--neutral)" strokeOpacity={0.45} strokeWidth={8} fill="none" />
      <path d={arc(20, 58)} stroke="var(--bull)" strokeOpacity={0.45} strokeWidth={8} fill="none" />
      <path d={arc(60, 100)} stroke="var(--bull)" strokeWidth={8} fill="none" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text-primary)" strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={4} fill="var(--text-primary)" />
    </svg>
  );
}

function WhyDrawer({ card, onClose }: { card: SignalCard; onClose: () => void }) {
  const sum = card.contributions.reduce((a, c) => a + c.contribution, 0);
  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Why ${TITLES[card.horizon]} is ${card.label}`}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h3 style={{ margin: 0 }}>Why {TITLES[card.horizon]}: {card.label}</h3><span className="spacer" /><button className="btn" onClick={onClose}>Close</button></div>
        <p className="secondary small">
          Score = Σ (weight × factor score) over available factors, weights re-normalised to 100%. Factor scores run −100 (bearish gold) to +100 (bullish).
          Instrument: {card.instrument}, {card.tf} bars.
        </p>
        <table>
          <thead><tr><th>Factor</th><th className="num">Score</th><th className="num">Weight</th><th className="num">Contribution</th></tr></thead>
          <tbody>
            {card.contributions.map((c) => (
              <tr key={c.id}>
                <td>{c.name}<div className="tiny muted">{c.detail}</div></td>
                <td className={`num ${c.score > 0 ? 'bull' : c.score < 0 ? 'bear' : ''}`}>{fmtSigned(c.score, 0)}</td>
                <td className="num">{(c.weight * 100).toFixed(1)}%</td>
                <td className={`num ${c.contribution > 0 ? 'bull' : c.contribution < 0 ? 'bear' : ''}`}>{fmtSigned(c.contribution, 1)}</td>
              </tr>
            ))}
            <tr><td><strong>Total</strong></td><td /><td className="num">100%</td><td className="num"><strong>{fmtSigned(sum, 1)}</strong></td></tr>
            {card.score !== card.rawScore && (
              <tr><td colSpan={3}>Event-risk damping (×0.6 within 2h of a high-impact event)</td><td className="num"><strong>{fmtSigned(card.score, 1)}</strong></td></tr>
            )}
          </tbody>
        </table>
        {card.excluded.length > 0 && (
          <>
            <h4>Excluded (data unavailable — weight re-distributed, never estimated)</h4>
            <ul className="small secondary">{card.excluded.map((e) => <li key={e.id}>{e.name}: {e.reason}</li>)}</ul>
          </>
        )}
        <p className="small secondary">
          Agreement {(card.agreement * 100).toFixed(0)}% of weighted contribution points the same way → confidence <strong>{card.confidence}</strong>
          {' '}(High &gt; 70%, Low &lt; 55%; one level lower when &gt; 30% of weight is missing).
        </p>
      </div>
    </div>
  );
}

export function SignalBoard({ data, error }: { data: SignalsResp | null; error: string | null }) {
  const [why, setWhy] = useState<SignalCard | null>(null);
  return (
    <Panel title="Signal board" right={<><Computed title="Weighted multi-factor score; see Why? for every input" /><Info text="Scores combine technical and macro factors (SPEC §6.3). Label thresholds: ≥60 Strong Buy, ≥20 Buy, −19…+19 Neutral, ≤−20 Sell, ≤−60 Strong Sell, with 5-point hysteresis. Not financial advice." /></>}>
      {!data?.cards.length && <div className="empty">{error ?? 'Waiting for enough real history to score…'}</div>}
      {data?.cards.map((c) => {
        const pos = [...c.contributions].filter((x) => x.contribution > 0).slice(0, 3);
        const neg = [...c.contributions].filter((x) => x.contribution < 0).sort((a, b) => a.contribution - b.contribution).slice(0, 3);
        const lc = labelClass(c.label);
        return (
          <div className="signal-card" key={c.horizon}>
            <div className="signal-top">
              <Gauge score={c.score} label={c.label} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <div className="row"><strong>{TITLES[c.horizon]}</strong><span className="tiny muted">{SUB[c.horizon]}</span></div>
                <div className="row">
                  <span className={`label-pill ${lc}`}>{lc === 'buy' ? '▲' : lc === 'sell' ? '▼' : '■'} {c.label}</span>
                  <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{fmtSigned(c.score, 0)}</span>
                </div>
                <div className="tiny secondary">Confidence <strong>{c.confidence}</strong> · <button className="btn" style={{ padding: '1px 8px' }} onClick={() => setWhy(c)}>Why?</button></div>
              </div>
            </div>
            <div className="drivers">
              <div><div className="tiny muted">Top bullish</div><ul>{pos.length ? pos.map((d) => <li key={d.id} title={d.detail}><span>{d.name}</span><span className="mono bull">{fmtSigned(d.contribution, 1)}</span></li>) : <li className="muted">none</li>}</ul></div>
              <div><div className="tiny muted">Top bearish</div><ul>{neg.length ? neg.map((d) => <li key={d.id} title={d.detail}><span>{d.name}</span><span className="mono bear">{fmtSigned(d.contribution, 1)}</span></li>) : <li className="muted">none</li>}</ul></div>
            </div>
            {c.eventRisk && (
              <div className="event-risk">⚠ Event risk: <strong>{c.eventRisk.event}</strong> {Date.parse(c.eventRisk.ts) > Date.now() ? `in ${timeUntil(c.eventRisk.ts)}` : 'now'} ({fmtDateTime(c.eventRisk.ts)})</div>
            )}
            <div className="levels-grid" title="Reference levels, not advice">
              <div className="kv"><span className="k">Support</span><span className="v">{c.levels.support ? `${fmt(c.levels.support.price)} ${c.levels.support.label}` : '—'}</span></div>
              <div className="kv"><span className="k">Resistance</span><span className="v">{c.levels.resistance ? `${fmt(c.levels.resistance.price)} ${c.levels.resistance.label}` : '—'}</span></div>
              <div className="kv"><span className="k">1.5×ATR stop</span><span className="v">{fmt(c.levels.stopDistance)}</span></div>
            </div>
            {c.history.length > 1 && (
              <div className="history-strip" role="img" aria-label={`Label history over the last 30 days: ${c.history.length} snapshots`}>
                {c.history.slice(-60).map((h, i) => (
                  <span key={i} title={`${fmtDateTime(h.ts)}: ${h.label} (${Math.round(h.score)})`} style={{ background: h.label.includes('BUY') ? 'var(--bull)' : h.label.includes('SELL') ? 'var(--bear)' : 'var(--surface-3)', opacity: h.label.includes('STRONG') ? 1 : 0.6 }} />
                ))}
              </div>
            )}
            <div className="tiny muted" style={{ marginTop: 4 }}>
              Reference levels, not advice · {c.lastChange ? `label changed ${timeAgo(c.lastChange)}` : 'no label change logged yet'}
            </div>
          </div>
        );
      })}
      {why && <WhyDrawer card={why} onClose={() => setWhy(null)} />}
    </Panel>
  );
}
