import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type ISeriesPrimitive, type SeriesAttachedParameter,
  type SeriesMarker, type Time, type UTCTimestamp, type IPrimitivePaneView, type IPrimitivePaneRenderer,
} from 'lightweight-charts';
import { loadPref, savePref, usePoll, useEventBump } from '../api';
import { Computed, Estimate, fmt, fmtDateTime, Info, timeAgo } from '../ui';

type TF = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';
const TFS: TF[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

interface Zone { price: number; low: number; high: number; strength: number; touches: number; kind: 'support' | 'resistance'; label: string; confluence: boolean }
interface CandlesResp {
  instrument: string; instrumentName: string; note: string; tf: TF; source: string; fetchedAt: string; forming: string | null;
  candles: { time: number; open: number; high: number; low: number; close: number; volume?: number }[];
  volumeSource: string | null;
  indicators: Record<string, { time: number; value: number }[]>;
}
interface LevelsResp {
  zones: Zone[];
  pivots: Record<'day' | 'week' | 'month', null | { classic: Record<string, number>; fibonacci: Record<string, number>; camarilla: Record<string, number>; basedOn: any }>;
  fib: null | { levels: { ratio: number; price: number }[]; from: any; to: any };
  inputs: string[];
}
export interface RangeBand { period: 'day' | 'week' | 'month'; low: number; high: number; extLow: number; extHigh: number; mid: number }
interface CalEvent { ts: string; country: string; event: string; impact: string }
interface NewsItem { ts: string; title: string; impact: number; direction: number }

export interface Overlays {
  sr: boolean; pivots: boolean; pivotMethod: 'classic' | 'fibonacci' | 'camarilla'; pivotPeriod: 'day' | 'week' | 'month';
  fib: boolean; mas: boolean; bb: boolean; vwap: boolean; ranges: boolean; rangePeriod: 'day' | 'week' | 'month'; events: boolean; volume: boolean;
  rsi: boolean; macd: boolean; atr: boolean;
}
const DEFAULT_OVERLAYS: Overlays = {
  sr: true, pivots: false, pivotMethod: 'classic', pivotPeriod: 'day', fib: false, mas: true, bb: false, vwap: false,
  ranges: false, rangePeriod: 'day', events: true, volume: false, rsi: true, macd: true, atr: false,
};

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const alpha = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** Draws S/R zones as translucent horizontal bands behind the candles. */
class ZonesPrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<'Candlestick'> | null = null;
  private request: (() => void) | null = null;
  zones: Zone[] = [];
  colors = { support: '#0ca30c', resistance: '#d03b3b' };
  attached(p: SeriesAttachedParameter<Time>) { this.series = p.series as ISeriesApi<'Candlestick'>; this.request = p.requestUpdate; }
  detached() { this.series = null; }
  setZones(z: Zone[]) { this.zones = z; this.request?.(); }
  paneViews(): IPrimitivePaneView[] {
    const self = this;
    const renderer: IPrimitivePaneRenderer = {
      draw(target) {
        target.useBitmapCoordinateSpace((scope) => {
          const s = self.series;
          if (!s) return;
          const ctx = scope.context;
          for (const z of self.zones) {
            const y1 = s.priceToCoordinate(z.high), y2 = s.priceToCoordinate(z.low);
            if (y1 == null || y2 == null) continue;
            const top = Math.min(y1, y2) * scope.verticalPixelRatio;
            const h = Math.max(2, Math.abs(y2 - y1) * scope.verticalPixelRatio);
            ctx.fillStyle = alpha(z.kind === 'support' ? self.colors.support : self.colors.resistance, 0.08 + 0.02 * Math.min(10, z.strength));
            ctx.fillRect(0, top, scope.bitmapSize.width, h);
          }
        });
      },
    };
    return [{ renderer: () => renderer, zOrder: () => 'bottom' }];
  }
}

export function GoldChart({ instruments, defaultInstrument, ranges, calendar, news, theme }: {
  instruments: { id: string; name: string; note: string }[];
  defaultInstrument: string | null;
  ranges: RangeBand[];
  calendar: CalEvent[];
  news: NewsItem[];
  theme: string;
}) {
  const [tf, setTf] = useState<TF>(() => loadPref('tf', '1h'));
  const [inst, setInst] = useState<string | null>(() => loadPref<string | null>('instrument', null));
  const [ov, setOv] = useState<Overlays>(() => ({ ...DEFAULT_OVERLAYS, ...loadPref<Partial<Overlays>>('overlays', {}) }));
  const instrument = inst && instruments.some((i) => i.id === inst) ? inst : defaultInstrument;
  const bump = useEventBump('candles');
  const q = instrument ? `instrument=${encodeURIComponent(instrument)}&tf=${tf}` : null;
  const { data, error } = usePoll<CandlesResp>(q ? `candles?${q}&limit=2000` : null, 30_000, bump);
  const { data: levels } = usePoll<LevelsResp>(q ? `levels?${q}` : null, 60_000, bump);

  const el = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const S = useRef<Record<string, ISeriesApi<any>>>({});
  const zonesPrim = useRef(new ZonesPrimitive());
  const priceLines = useRef<IPriceLine[]>([]);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fitted = useRef<string>('');

  const set = (k: keyof Overlays, v: any) => setOv((o) => { const n = { ...o, [k]: v }; savePref('overlays', n); return n; });
  useEffect(() => savePref('tf', tf), [tf]);

  const stripKey = `${ov.rsi}${ov.macd}${ov.atr}`;

  // Create chart (recreated when the indicator strip layout or theme changes).
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css('--surface-1') }, textColor: css('--text-secondary'), fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11, panes: { separatorColor: css('--border') } },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css('--border') },
      timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { priceFormatter: (p: number) => fmt(p, 2) },
    });
    chart.current = c;
    const bull = css('--bull'), bear = css('--bear');
    const s: Record<string, ISeriesApi<any>> = {};
    s.candles = c.addSeries(CandlestickSeries, { upColor: bull, downColor: bear, wickUpColor: bull, wickDownColor: bear, borderVisible: false, priceLineColor: css('--gold') });
    zonesPrim.current.colors = { support: bull, resistance: bear };
    s.candles.attachPrimitive(zonesPrim.current);
    s.volume = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    s.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = (color: string, width: 1 | 2 = 2, pane = 0, style: LineStyle = LineStyle.Solid, title = '') =>
      c.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title }, pane);
    s.ema20 = line(css('--s1')); s.ema50 = line(css('--s2')); s.ema200 = line(css('--s3'));
    const muted = css('--text-muted');
    s.bbUpper = line(muted, 1, 0, LineStyle.Dotted); s.bbMid = line(muted, 1, 0, LineStyle.Dotted); s.bbLower = line(muted, 1, 0, LineStyle.Dotted);
    s.vwap = line(css('--s4'), 2);
    let pane = 1;
    const heights: number[] = [];
    if (ov.rsi) { s.rsi = line(css('--s3'), 2, pane, LineStyle.Solid, 'RSI 14'); s.rsi.applyOptions({ lastValueVisible: true }); s.rsi.createPriceLine({ price: 70, color: muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }); s.rsi.createPriceLine({ price: 30, color: muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }); heights.push(pane++); }
    if (ov.macd) {
      s.macdHist = c.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      s.macd = line(css('--s1'), 2, pane, LineStyle.Solid, 'MACD'); s.macdSignal = line(css('--s2'), 2, pane, LineStyle.Solid, 'Signal');
      heights.push(pane++);
    }
    if (ov.atr) { s.atr = line(css('--s4'), 2, pane, LineStyle.Solid, 'ATR 14'); s.atr.applyOptions({ lastValueVisible: true }); heights.push(pane++); }
    const panes = c.panes();
    heights.forEach((p) => panes[p]?.setHeight(90));
    S.current = s;
    markers.current = createSeriesMarkers(s.candles, []);

    c.subscribeCrosshairMove((param) => {
      if (!legend.current) return;
      const d = param.seriesData.get(s.candles) as any;
      if (!d) { legend.current.dataset.hover = ''; return; }
      legend.current.dataset.hover = '1';
      const chg = d.close - d.open;
      legend.current.innerHTML = `<span class="mono">O ${fmt(d.open)}</span><span class="mono">H ${fmt(d.high)}</span><span class="mono">L ${fmt(d.low)}</span><span class="mono ${chg >= 0 ? 'bull' : 'bear'}">C ${fmt(d.close)} (${chg >= 0 ? '+' : ''}${fmt(chg)})</span>`;
    });
    fitted.current = '';
    return () => { c.remove(); chart.current = null; S.current = {}; markers.current = null; priceLines.current = []; };
  }, [stripKey, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Candles + indicator data.
  useEffect(() => {
    const s = S.current;
    if (!data || !s.candles) return;
    const t = (x: number) => x as UTCTimestamp;
    s.candles.setData(data.candles.map((c) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    const bull = alpha(css('--bull'), 0.45), bear = alpha(css('--bear'), 0.45);
    s.volume.setData(ov.volume && data.volumeSource ? data.candles.filter((c) => c.volume != null).map((c) => ({ time: t(c.time), value: c.volume!, color: c.close >= c.open ? bull : bear })) : []);
    const ln = (k: string, on: boolean) => s[k]?.setData(on ? (data.indicators[k] ?? []).map((p) => ({ time: t(p.time), value: p.value })) : []);
    ln('ema20', ov.mas); ln('ema50', ov.mas); ln('ema200', ov.mas);
    ln('bbUpper', ov.bb); ln('bbMid', ov.bb); ln('bbLower', ov.bb);
    ln('vwap', ov.vwap);
    ln('rsi', true); ln('macd', true); ln('macdSignal', true); ln('atr', true);
    if (s.macdHist) {
      const b = alpha(css('--bull'), 0.6), r = alpha(css('--bear'), 0.6);
      s.macdHist.setData((data.indicators.macdHist ?? []).map((p) => ({ time: t(p.time), value: p.value, color: p.value >= 0 ? b : r })));
    }
    const key = `${data.instrument}:${data.tf}`;
    if (fitted.current !== key && chart.current) {
      const n = data.candles.length;
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 180), to: n + 5 });
      fitted.current = key;
    }
    if (legend.current && !legend.current.dataset.hover && data.candles.length) {
      const d = data.candles[data.candles.length - 1];
      legend.current.innerHTML = `<span class="mono">O ${fmt(d.open)}</span><span class="mono">H ${fmt(d.high)}</span><span class="mono">L ${fmt(d.low)}</span><span class="mono">C ${fmt(d.close)}</span>`;
    }
  }, [data, ov.mas, ov.bb, ov.vwap, ov.volume, stripKey, theme]);

  // Levels, pivots, fib, ranges → zones + price lines.
  useEffect(() => {
    const s = S.current.candles;
    if (!s) return;
    priceLines.current.forEach((l) => s.removePriceLine(l));
    priceLines.current = [];
    const add = (price: number, color: string, title: string, style = LineStyle.Solid, width: 1 | 2 = 1) =>
      priceLines.current.push(s.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    const zones = ov.sr ? levels?.zones ?? [] : [];
    zonesPrim.current.setZones(zones);
    for (const z of zones) add(z.price, z.kind === 'support' ? css('--bull') : css('--bear'), `${z.label} · ${z.strength.toFixed(1)}${z.confluence ? ' ◆' : ''}`, LineStyle.Solid, 1);
    const pv = levels?.pivots?.[ov.pivotPeriod]?.[ov.pivotMethod];
    if (ov.pivots && pv) for (const [k, v] of Object.entries(pv)) add(v, css('--s5'), `${ov.pivotPeriod[0].toUpperCase()}·${k}`, k === 'P' ? LineStyle.Solid : LineStyle.Dashed);
    if (ov.fib && levels?.fib) for (const l of levels.fib.levels) add(l.price, css('--s6'), `Fib ${(l.ratio * 100).toFixed(1)}%`, LineStyle.Dotted);
    const band = ranges.find((r) => r.period === ov.rangePeriod);
    if (ov.ranges && band && data?.instrument === defaultInstrument) {
      add(band.high, css('--s1'), `${ov.rangePeriod} est. high`, LineStyle.Dashed, 2);
      add(band.low, css('--s1'), `${ov.rangePeriod} est. low`, LineStyle.Dashed, 2);
      add(band.extHigh, css('--s1'), `${ov.rangePeriod} ext. high`, LineStyle.SparseDotted);
      add(band.extLow, css('--s1'), `${ov.rangePeriod} ext. low`, LineStyle.SparseDotted);
    }
  }, [levels, ranges, ov.sr, ov.pivots, ov.pivotMethod, ov.pivotPeriod, ov.fib, ov.ranges, ov.rangePeriod, stripKey, theme, data?.instrument, defaultInstrument]);

  // Event markers: high-impact calendar events + high-impact news, snapped to the bar containing them.
  useEffect(() => {
    if (!markers.current || !data) return;
    if (!ov.events || !data.candles.length) { markers.current.setMarkers([]); return; }
    const times = data.candles.map((c) => c.time);
    const first = times[0], last = times[times.length - 1];
    const snap = (sec: number) => {
      let lo = 0, hi = times.length - 1, ans = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= sec) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans >= 0 ? times[ans] : null;
    };
    const m: SeriesMarker<Time>[] = [];
    for (const e of calendar) {
      const sec = Date.parse(e.ts) / 1000;
      if (e.impact !== 'high' || sec < first || sec > last + 3600) continue;
      const tt = snap(sec);
      if (tt != null) m.push({ time: tt as UTCTimestamp, position: 'aboveBar', shape: 'square', color: css('--warn'), text: `${e.country} ${e.event}`.slice(0, 28) });
    }
    for (const n of news) {
      const sec = Date.parse(n.ts) / 1000;
      if (n.impact < 4 || sec < first) continue;
      const tt = snap(sec);
      if (tt != null) m.push({ time: tt as UTCTimestamp, position: n.direction >= 0 ? 'belowBar' : 'aboveBar', shape: n.direction > 0 ? 'arrowUp' : n.direction < 0 ? 'arrowDown' : 'circle', color: n.direction > 0 ? css('--bull') : n.direction < 0 ? css('--bear') : css('--text-muted'), text: 'News' });
    }
    m.sort((a, b) => (a.time as number) - (b.time as number));
    markers.current.setMarkers(m);
  }, [data, calendar, news, ov.events, stripKey, theme]);

  const lastBar = data?.candles[data.candles.length - 1];
  const legendItems = useMemo(() => [
    ov.mas && { c: '--s1', t: 'EMA 20' }, ov.mas && { c: '--s2', t: 'EMA 50' }, ov.mas && { c: '--s3', t: 'EMA 200' },
    ov.bb && { c: '--text-muted', t: 'Bollinger 20,2σ' }, ov.vwap && data?.volumeSource && { c: '--s4', t: 'VWAP' },
    ov.pivots && { c: '--s5', t: `Pivots (${ov.pivotMethod}, ${ov.pivotPeriod})` }, ov.fib && { c: '--s6', t: 'Fibonacci' },
    ov.ranges && { c: '--s1', t: `Projected ${ov.rangePeriod} range` },
  ].filter(Boolean) as { c: string; t: string }[], [ov, data?.volumeSource]);

  const Chip = ({ k, label, swatch, band }: { k: keyof Overlays; label: string; swatch?: string; band?: boolean }) => (
    <label className="chip">
      <input type="checkbox" checked={ov[k] as boolean} onChange={(e) => set(k, e.target.checked)} />
      {swatch && <span className={`swatch ${band ? 'band' : ''}`} style={{ background: swatch.startsWith('--') ? `var(${swatch})` : swatch }} />}
      {label}
    </label>
  );

  return (
    <section className="panel" aria-label="Gold price chart">
      <div className="chart-toolbar">
        <select aria-label="Instrument" value={instrument ?? ''} onChange={(e) => { setInst(e.target.value); savePref('instrument', e.target.value); }}>
          {instruments.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <div className="seg" role="group" aria-label="Timeframe">
          {TFS.map((x) => <button key={x} className={x === tf ? 'on' : ''} onClick={() => setTf(x)} aria-pressed={x === tf}>{x.toUpperCase()}</button>)}
        </div>
        <span className="spacer" />
        {data && <span className="tiny muted">Updated {timeAgo(data.fetchedAt)}</span>}
      </div>
      <div className="chart-toolbar">
        <Chip k="sr" label="Support / Resistance" swatch="linear-gradient(90deg, var(--bull) 50%, var(--bear) 50%)" band />
        <Chip k="pivots" label="Pivots" swatch="--s5" />
        {ov.pivots && (
          <>
            <select aria-label="Pivot method" value={ov.pivotMethod} onChange={(e) => set('pivotMethod', e.target.value)}>
              <option value="classic">Classic</option><option value="fibonacci">Fibonacci</option><option value="camarilla">Camarilla</option>
            </select>
            <select aria-label="Pivot period" value={ov.pivotPeriod} onChange={(e) => set('pivotPeriod', e.target.value)}>
              <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option>
            </select>
          </>
        )}
        <Chip k="fib" label="Fibonacci" swatch="--s6" />
        <Chip k="mas" label="EMAs" swatch="--s1" />
        <Chip k="bb" label="Bollinger" swatch="--text-muted" />
        <Chip k="vwap" label="VWAP" swatch="--s4" />
        <Chip k="ranges" label="Range bands" swatch="--s1" />
        {ov.ranges && (
          <select aria-label="Range period" value={ov.rangePeriod} onChange={(e) => set('rangePeriod', e.target.value)}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
          </select>
        )}
        <Chip k="events" label="Event markers" swatch="--warn" />
        <Chip k="volume" label="Volume" />
        <span className="muted tiny">|</span>
        <Chip k="rsi" label="RSI" />
        <Chip k="macd" label="MACD" />
        <Chip k="atr" label="ATR" />
      </div>
      <div className="chart-wrap">
        <div className="chart-legend" ref={legend} />
        <div ref={el} style={{ position: 'absolute', inset: 0 }} />
        {!data && <div className="empty" style={{ position: 'absolute', inset: 0 }}>{error ? `Chart unavailable: ${error}` : 'Loading real candles…'}</div>}
      </div>
      <div className="chart-note">
        {data && <span><strong className="secondary">{data.instrumentName}</strong> · {data.source}</span>}
        {data?.instrument === 'GC=F' && <span title={data.note}>⚠ Futures prices differ from spot by the futures basis (shown in header).</span>}
        {data?.forming && <span>● {data.forming}</span>}
        {ov.volume && data && !data.volumeSource && <span>Volume unavailable for this source — hidden, not estimated.</span>}
        {ov.vwap && data && !data.volumeSource && <span>VWAP needs volume — hidden.</span>}
        {legendItems.map((l) => <span key={l.t} className="row" style={{ gap: 4 }}><span className="swatch" style={{ background: `var(${l.c})` }} />{l.t}</span>)}
        {ov.sr && levels && <span className="row" style={{ gap: 4 }}><Computed title={levels.inputs.join(' · ')} /> S/R zones: strength 0–10, ◆ = higher-timeframe confluence</span>}
        {ov.ranges && <Estimate />}
        {lastBar && <span className="mono">Last {fmtDateTime(new Date(lastBar.time * 1000).toISOString())}</span>}
        <Info text="Zones: fractal swing highs/lows clustered within 0.25×ATR, scored by touches, recency, rejection wicks, round numbers and higher-timeframe confluence. Markers: squares = high-impact calendar events; arrows = high-impact news (direction from the rules classifier)." />
      </div>
    </section>
  );
}
