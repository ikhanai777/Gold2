import { Computed, fmt, fmtSigned, Fresh, Info, Panel, Sparkline, type Freshness } from '../ui';

export interface Factor {
  id: string; name: string; group: string; value: number | null; unit: string; decimals: number;
  change1d: number | null; change1w: number | null; spark: { date: string; value: number }[];
  impact: 'Bullish' | 'Bearish' | 'Neutral'; impactNote: string; corr30d: number | null;
  source: string; ts: string | null; status: Freshness; computed?: boolean; why: string;
}

const val = (f: Factor) => {
  if (f.value == null) return '—';
  if (f.unit === '$') return `$${fmt(f.value, f.decimals)}`;
  if (f.unit === '%') return `${fmt(f.value, f.decimals)}%`;
  if (f.unit === 't') return `${fmt(f.value, f.decimals)} t`;
  return fmt(f.value, f.decimals);
};

export function FactorMonitor({ factors, error }: { factors: Factor[] | null; error: string | null }) {
  const groups = new Map<string, Factor[]>();
  for (const f of factors ?? []) (groups.get(f.group) ?? groups.set(f.group, []).get(f.group)!).push(f);
  return (
    <Panel title="Factor monitor" right={<Info text="Each factor's gold impact comes from its 1-week direction and its usual relationship with gold. ρ30 = 30-day correlation of daily % changes with gold." />}>
      {!factors && <div className="empty">{error ?? 'Loading factors…'}</div>}
      {[...groups].map(([g, fs]) => (
        <div key={g}>
          <div className="factor-group">{g}</div>
          {fs.map((f) => (
            <div className="factor" key={f.id}>
              <div className="name"><span className="t" title={f.name}>{f.name}</span><Info text={f.why} /></div>
              <div className="value">{val(f)}</div>
              <Sparkline points={f.spark} />
              <div className="meta">
                <span className={`tag ${f.impact}`} title={f.impactNote}>{f.impact === 'Bullish' ? '▲' : f.impact === 'Bearish' ? '▼' : '■'} {f.impact}</span>
                {f.change1d != null && <span className="mono">1d {fmtSigned(f.change1d, f.decimals)}</span>}
                {f.change1w != null && <span className="mono">1w {fmtSigned(f.change1w, f.decimals)}</span>}
                {f.corr30d != null && <span className="mono" title="30-day correlation of daily changes with gold">ρ30 {fmtSigned(f.corr30d, 2)}</span>}
                <Fresh status={f.status} ts={f.ts} source={f.source} />
                {f.computed && <Computed title={f.source} />}
              </div>
              <div className="meta" style={{ marginTop: -2 }}><span title={f.source} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.impactNote} · {f.source}</span></div>
            </div>
          ))}
        </div>
      ))}
    </Panel>
  );
}
