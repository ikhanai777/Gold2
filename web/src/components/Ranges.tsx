import { Estimate, fmt, Info, Panel } from '../ui';

export interface Band {
  period: 'day' | 'week' | 'month'; periodStart: number; open: number; mid: number; sigma: number; low: number; high: number;
  extLow: number; extHigh: number; method: string; inputs: string[]; hitRate68: number | null; hitRate95: number | null;
  samples: number; snapped: string[]; realizedHigh: number; realizedLow: number;
}
export interface RangesResp { instrument: string | null; bands: Band[]; ts: string }

const NAMES = { day: 'Today', week: 'This week', month: 'This month' };

export function Ranges({ data, price }: { data: RangesResp | null; price: number | null }) {
  return (
    <Panel title="Projected ranges" right={<><Estimate /><Info text="Expected band ≈ 68%, extended ≈ 95%. σ blends GVZ implied volatility (60%) with a walk-forward-calibrated ATR multiple (40%), centred on the period open with a small skew toward the signal. Hit rates are out-of-sample on real history: the share of past periods whose close stayed inside the band." /></>}>
      {!data?.bands.length && <div className="empty">Waiting for daily history…</div>}
      {data?.bands.map((b) => {
        const lo = Math.min(b.extLow, b.realizedLow), hi = Math.max(b.extHigh, b.realizedHigh);
        const pct = (x: number) => `${(((x - lo) / (hi - lo || 1)) * 100).toFixed(2)}%`;
        const inside = price != null && price >= b.low && price <= b.high;
        const hit = b.hitRate68 != null ? `${(b.hitRate68 * 100).toFixed(0)}% / ${((b.hitRate95 ?? 0) * 100).toFixed(0)}%` : 'n/a';
        return (
          <div className="range-row" key={b.period}>
            <div className="row">
              <strong>{NAMES[b.period]}</strong>
              <span className="tiny muted">from open {fmt(b.open)}</span>
              <span className="spacer" />
              {price != null && data.instrument && <span className={`tag ${inside ? 'neutral' : price > b.high ? 'bull' : 'bear'}`}>{inside ? 'inside band' : price > b.high ? '▲ above band' : '▼ below band'}</span>}
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <div className="kv"><span className="k">Expected low</span><span className="v bear">{fmt(b.low)}</span></div>
              <div className="kv" style={{ alignItems: 'flex-end' }}><span className="k">Expected high</span><span className="v bull">{fmt(b.high)}</span></div>
            </div>
            <div className="range-bar" role="img" aria-label={`${NAMES[b.period]} expected ${fmt(b.low)} to ${fmt(b.high)}, extended ${fmt(b.extLow)} to ${fmt(b.extHigh)}`}>
              <div className="ext" style={{ left: pct(b.extLow), right: `calc(100% - ${pct(b.extHigh)})` }} />
              <div className="core" style={{ left: pct(b.low), right: `calc(100% - ${pct(b.high)})` }} />
              <div className="realized" title={`Realised so far: ${fmt(b.realizedLow)} – ${fmt(b.realizedHigh)}`} style={{ left: pct(b.realizedLow), right: `calc(100% - ${pct(b.realizedHigh)})` }} />
            </div>
            <div className="row tiny muted" style={{ justifyContent: 'space-between' }}>
              <span className="mono">ext {fmt(b.extLow)}</span>
              <span>realised {fmt(b.realizedLow)} – {fmt(b.realizedHigh)}</span>
              <span className="mono">ext {fmt(b.extHigh)}</span>
            </div>
            <div className="tiny muted" style={{ marginTop: 4 }} title={b.inputs.join('\n')}>
              {b.method} · hit rate 68%/95% bands: <strong className="secondary">{hit}</strong> ({b.samples} periods)
              {b.snapped.length > 0 && ` · snapped ${b.snapped.join(', ')}`}
            </div>
          </div>
        );
      })}
      {data?.instrument && <div className="tiny muted" style={{ padding: '0 12px 10px' }}>Computed on {data.instrument === 'GC=F' ? 'COMEX futures (GC=F)' : 'XAU/USD spot'} daily bars.</div>}
    </Panel>
  );
}
