import { useMemo, useState } from 'react';
import { loadPref, savePref } from '../api';
import { Computed, Info, Panel, timeAgo } from '../ui';

export interface NewsItem { id: string; title: string; url: string; source: string; feed: string; ts: string; snippet: string; topic: string; direction: number; impact: number; rationale: string }
const TOPICS = ['All', 'Fed/Rates', 'Inflation', 'USD', 'Geopolitics', 'Central Banks', 'Physical Demand', 'ETFs', 'Mining/Supply', 'Gold Market', 'Other'];

export function NewsFeed({ items, error }: { items: NewsItem[] | null; error: string | null }) {
  const [topic, setTopic] = useState<string>(() => loadPref('newsTopic', 'All'));
  const [highOnly, setHighOnly] = useState<boolean>(() => loadPref('newsHigh', false));
  const [relevantOnly, setRelevantOnly] = useState<boolean>(() => loadPref('newsRelevant', true));
  const shown = useMemo(() => (items ?? []).filter((n) => (topic === 'All' || n.topic === topic) && (!highOnly || n.impact >= 3) && (!relevantOnly || n.impact > 0)), [items, topic, highOnly, relevantOnly]);
  const idx = useMemo(() => {
    const r = (items ?? []).filter((n) => n.impact > 0 && Date.now() - Date.parse(n.ts) < 86400e3);
    return r.length ? r.reduce((a, n) => a + n.direction * n.impact, 0) / r.length : null;
  }, [items]);
  return (
    <Panel
      title="News feed"
      right={
        <>
          {idx != null && <span className={`tag ${idx > 0.2 ? 'bull' : idx < -0.2 ? 'bear' : 'neutral'}`} title="24h sentiment index: average of impact × direction for gold-relevant items (−5…+5)">24h sentiment {idx > 0 ? '+' : ''}{idx.toFixed(2)}</span>}
          <Computed title="Topic, direction and impact tags come from a local rules-based classifier; headlines are shown exactly as published." />
          <Info text="Sources: Google News search, Yahoo Finance (GC=F), Investing.com commodities, BBC World, Federal Reserve and ECB press feeds, GDELT (and Finnhub with a free key). Duplicates are merged by URL and title similarity." />
        </>
      }
    >
      <div className="chart-toolbar">
        <select aria-label="Topic" value={topic} onChange={(e) => { setTopic(e.target.value); savePref('newsTopic', e.target.value); }}>
          {TOPICS.map((t) => <option key={t}>{t}</option>)}
        </select>
        <label className="chip"><input type="checkbox" checked={highOnly} onChange={(e) => { setHighOnly(e.target.checked); savePref('newsHigh', e.target.checked); }} /> High impact only</label>
        <label className="chip"><input type="checkbox" checked={relevantOnly} onChange={(e) => { setRelevantOnly(e.target.checked); savePref('newsRelevant', e.target.checked); }} /> Gold-relevant only</label>
        <span className="spacer" />
        <span className="tiny muted">{shown.length} items · last 48h</span>
      </div>
      <div className="news-list">
        {!items && <div className="empty">{error ?? 'Loading news…'}</div>}
        {items && !shown.length && <div className="empty">No items match these filters.</div>}
        {shown.map((n) => (
          <article className="news-item" key={n.id}>
            <a href={n.url} target="_blank" rel="noopener noreferrer">{n.title}</a>
            <div className="row tiny muted" style={{ flexWrap: 'wrap' }}>
              <span>{n.source}</span><span>·</span><span title={new Date(n.ts).toLocaleString()}>{timeAgo(n.ts)}</span>
              {n.feed !== n.source && <><span>·</span><span>via {n.feed}</span></>}
              <span className="spacer" />
              <span className="tag neutral">{n.topic}</span>
              <span className={`tag ${n.direction > 0 ? 'bull' : n.direction < 0 ? 'bear' : 'neutral'}`} title={n.rationale}>
                {n.direction > 0 ? '▲ Bullish' : n.direction < 0 ? '▼ Bearish' : '■ Neutral'}
              </span>
              <span className="impact-dots" title={`Impact ${n.impact}/5`} aria-label={`Impact ${n.impact} of 5`}>
                {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n.impact ? 'on' : ''} />)}
              </span>
            </div>
            {n.snippet && <div className="small secondary">{n.snippet}</div>}
          </article>
        ))}
      </div>
    </Panel>
  );
}
