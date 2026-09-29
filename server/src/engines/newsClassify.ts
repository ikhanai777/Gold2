// Rules-based news classifier ($0, runs locally). Tags are computed labels,
// shown with a "Computed" badge; the headline itself is never altered.
import type { Direction } from '../types.js';

export type Topic = 'Fed/Rates' | 'Inflation' | 'USD' | 'Geopolitics' | 'Central Banks' | 'Physical Demand' | 'ETFs' | 'Mining/Supply' | 'Gold Market' | 'Other';

interface Rule { re: RegExp; topic: Topic; dir: Direction; impact: number; why: string }

// Ordered: first matching rule sets the topic; all matching rules add to direction/impact.
const RULES: Rule[] = [
  { re: /\b(rate cut|cuts? rates|dovish|easing|lower(ed)? rates|pause[sd]? hikes)\b/i, topic: 'Fed/Rates', dir: 1, impact: 4, why: 'Easier policy lowers real yields (bullish gold)' },
  { re: /\b(rate hike|hikes? rates|hawkish|tightening|higher for longer|raise[sd]? rates)\b/i, topic: 'Fed/Rates', dir: -1, impact: 4, why: 'Tighter policy lifts real yields (bearish gold)' },
  { re: /\b(fomc|federal reserve|fed chair|powell|fed officials?|fed's)\b/i, topic: 'Fed/Rates', dir: 0, impact: 3, why: 'Fed policy news moves real yields' },
  { re: /\b(treasury yields?|bond yields?|real yields?|tips)\b.*\b(fall|drop|slide|decline|lower|tumble)/i, topic: 'Fed/Rates', dir: 1, impact: 3, why: 'Falling yields support gold' },
  { re: /\b(treasury yields?|bond yields?|real yields?)\b.*\b(rise|jump|climb|surge|higher|spike)/i, topic: 'Fed/Rates', dir: -1, impact: 3, why: 'Rising yields weigh on gold' },
  { re: /\b(inflation|cpi|pce|consumer prices)\b.*\b(hotter|higher|rise|rises|jump|accelerat|surge|above)/i, topic: 'Inflation', dir: -1, impact: 3, why: 'Hot inflation → hawkish Fed risk (short-term bearish)' },
  { re: /\b(inflation|cpi|pce|consumer prices)\b.*\b(cool|slow|lower|fall|ease|below|soft)/i, topic: 'Inflation', dir: 1, impact: 3, why: 'Cooling inflation → room for cuts (bullish)' },
  { re: /\b(inflation|cpi|pce|stagflation)\b/i, topic: 'Inflation', dir: 0, impact: 2, why: 'Inflation data drives rate expectations' },
  { re: /\b(jobs report|nonfarm|payrolls|unemployment)\b.*\b(weak|miss|rise in unemployment|slows?|below)/i, topic: 'Fed/Rates', dir: 1, impact: 3, why: 'Weak labour data → cuts priced (bullish)' },
  { re: /\b(jobs report|nonfarm|payrolls)\b.*\b(strong|beat|surge|above)/i, topic: 'Fed/Rates', dir: -1, impact: 3, why: 'Strong labour data → fewer cuts (bearish)' },
  { re: /\b(dollar|greenback|dxy)\b.*\b(strengthen|rall|jump|gain|climb|surge|firm)/i, topic: 'USD', dir: -1, impact: 3, why: 'Stronger USD weighs on gold' },
  { re: /\b(dollar|greenback|dxy)\b.*\b(weaken|slide|fall|drop|slump|decline|soft)/i, topic: 'USD', dir: 1, impact: 3, why: 'Weaker USD supports gold' },
  { re: /\b(war|invasion|missile|airstrike|strikes? on|military|attack|conflict|escalat|nuclear|sanction|coup|terror)/i, topic: 'Geopolitics', dir: 1, impact: 3, why: 'Geopolitical risk raises safe-haven demand' },
  { re: /\b(ceasefire|peace (deal|talks|agreement)|truce|de-?escalat)/i, topic: 'Geopolitics', dir: -1, impact: 2, why: 'Easing tensions reduce safe-haven demand' },
  { re: /\b(tariffs?|trade war|trade tensions)\b/i, topic: 'Geopolitics', dir: 1, impact: 2, why: 'Trade conflict adds uncertainty (safe-haven bid)' },
  { re: /\bcentral banks?\b.*\b(buy|bought|purchas|add|accumul)|\b(pboc|rbi|nbp|cbrt)\b.*gold/i, topic: 'Central Banks', dir: 1, impact: 3, why: 'Official-sector buying is structural demand' },
  { re: /\bcentral banks?\b.*\b(sell|sold|sales)\b.*gold/i, topic: 'Central Banks', dir: -1, impact: 3, why: 'Official-sector selling adds supply' },
  { re: /\b(ecb|bank of japan|boj|bank of england|pboc|snb)\b/i, topic: 'Central Banks', dir: 0, impact: 2, why: 'Other central banks move USD & yields' },
  { re: /\b(etf|gld|spdr gold)\b.*\b(inflow|holdings (rise|climb|increase))/i, topic: 'ETFs', dir: 1, impact: 2, why: 'ETF inflows add investment demand' },
  { re: /\b(etf|gld|spdr gold)\b.*\b(outflow|holdings (fall|drop|decline))/i, topic: 'ETFs', dir: -1, impact: 2, why: 'ETF outflows reduce demand' },
  { re: /\b(india|china|chinese|indian|jewellery|jewelry|diwali|akshaya|wedding season|shanghai gold)\b.*\b(demand|buy|imports?|premium)/i, topic: 'Physical Demand', dir: 1, impact: 2, why: 'Physical demand from Asia' },
  { re: /\b(mine|mining|miner|output|production|supply)\b.*\bgold\b|\bgold\b.*\b(mine|mining|output|production)\b/i, topic: 'Mining/Supply', dir: 0, impact: 1, why: 'Supply-side news (slow-moving)' },
  { re: /\b(safe[- ]haven|risk[- ]off|market turmoil|sell-?off|recession fears?|banking crisis)\b/i, topic: 'Geopolitics', dir: 1, impact: 2, why: 'Risk-off flows favour gold' },
  { re: /\bgold\b.*\b(record|all-time high|rall|surge|jump|climb|gain|rise|rises|up)\b/i, topic: 'Gold Market', dir: 1, impact: 2, why: 'Reported gold price strength' },
  { re: /\bgold\b.*\b(slump|drop|fall|falls|slide|tumble|decline|down|retreat|loses?)\b/i, topic: 'Gold Market', dir: -1, impact: 2, why: 'Reported gold price weakness' },
  { re: /\b(gold|bullion|xau|precious metals?)\b/i, topic: 'Gold Market', dir: 0, impact: 1, why: 'Gold-related news' },
];

export interface Classified { topic: Topic; direction: Direction; impact: number; rationale: string }

export function classify(title: string, snippet = '', tone?: number): Classified {
  const text = `${title}. ${snippet}`;
  let topic: Topic | null = null;
  let dirSum = 0, impact = 0;
  const whys: string[] = [];
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    topic ??= r.topic;
    dirSum += r.dir * r.impact;
    impact = Math.max(impact, r.impact);
    if (whys.length < 2 && !whys.includes(r.why)) whys.push(r.why);
  }
  // GDELT article tone (≈ -10..+10) only nudges already-relevant geopolitical items.
  if (tone != null && topic === 'Geopolitics' && tone < -5) impact = Math.min(5, impact + 1);
  const direction: Direction = dirSum > 0 ? 1 : dirSum < 0 ? -1 : 0;
  if (/\b(breaking|urgent|emergency)\b/i.test(title)) impact = Math.min(5, impact + 1);
  return { topic: topic ?? 'Other', direction, impact, rationale: whys.join('; ') || 'No gold-relevant keywords matched' };
}

/** Normalised title for de-duplication. */
export function normTitle(t: string) {
  return t.toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Jaccard similarity on word bigrams. */
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const w = s.split(' ');
    const g = new Set<string>();
    for (let i = 0; i < w.length - 1; i++) g.add(w[i] + ' ' + w[i + 1]);
    if (w.length === 1) g.add(w[0]);
    return g;
  };
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
