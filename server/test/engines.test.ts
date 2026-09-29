// Unit tests for the analytics engines. Inputs are small hand-written arrays
// used only to verify the maths; they live under test/ and are never bundled
// into the app (see scripts/check-integrity.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, toWeekly } from '../src/engines/aggregate.js';
import { atr, ema, pivots, rsi, sma, changeZ } from '../src/engines/indicators.js';
import { classify, normTitle, similarity } from '../src/engines/newsClassify.js';
import { combine, labelFor, cotScore } from '../src/engines/scoring.js';
import { detectZones } from '../src/engines/levels.js';
import { nyToUtc } from '../src/providers/news.js';
import type { Candle } from '../src/types.js';

const bar = (time: number, o: number, h: number, l: number, c: number, v?: number): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v });

test('sma/ema basic values and NaN warm-up (no back-fill)', () => {
  const v = [1, 2, 3, 4, 5];
  assert.deepEqual(sma(v, 3).slice(2), [2, 3, 4]);
  assert.ok(Number.isNaN(sma(v, 3)[1]));
  const e = ema(v, 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4*0.5 + 2*0.5
});

test('rsi is 100 on a monotonic rise', () => {
  const v = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(v, 14)[29], 100);
});

test('atr of constant-range bars equals the range', () => {
  const c = Array.from({ length: 20 }, (_, i) => bar(i * 60, 10, 11, 9, 10));
  assert.equal(atr(c, 14)[19], 2);
});

test('classic pivots', () => {
  const p = pivots(bar(0, 0, 110, 90, 100), 'classic');
  assert.equal(p.P, 100);
  assert.equal(p.R1, 110);
  assert.equal(p.S1, 90);
});

test('aggregate keeps real OHLC and leaves gaps as gaps', () => {
  const base = [bar(0, 1, 2, 0.5, 1.5, 10), bar(60, 1.5, 3, 1, 2, 5), bar(600, 2, 2.5, 1.8, 2.2, 1)]; // gap 120–600
  const five = aggregate(base, 300);
  assert.equal(five.length, 2); // bucket 300 has no data → absent, not synthesised
  assert.deepEqual(five[0], { time: 0, open: 1, high: 3, low: 0.5, close: 2, volume: 15 });
  assert.equal(five[1].time, 600);
});

test('weekly aggregation starts on Monday UTC', () => {
  const mon = Date.UTC(2026, 8, 28) / 1000; // Monday 2026-09-28
  const w = toWeekly([bar(mon - 86400 * 3, 1, 1, 1, 1), bar(mon, 2, 2, 2, 2), bar(mon + 86400 * 4, 3, 3, 3, 3)]);
  assert.equal(w.length, 2);
  assert.equal(w[1].time, mon);
  assert.equal(w[1].close, 3);
});

test('labelFor thresholds and hysteresis', () => {
  assert.equal(labelFor(65), 'STRONG BUY');
  assert.equal(labelFor(25), 'BUY');
  assert.equal(labelFor(0), 'NEUTRAL');
  assert.equal(labelFor(-25), 'SELL');
  assert.equal(labelFor(-70), 'STRONG SELL');
  assert.equal(labelFor(22, 'NEUTRAL'), 'NEUTRAL'); // crossed 20 by < 5
  assert.equal(labelFor(26, 'NEUTRAL'), 'BUY');
  assert.equal(labelFor(18, 'BUY'), 'BUY'); // needs ≤ 15 to drop back
  assert.equal(labelFor(14, 'BUY'), 'NEUTRAL');
});

test('combine: contributions sum to the score; unavailable factors are excluded', () => {
  const r = combine('swing', [
    { id: 'trend', score: 100, detail: '' },
    { id: 'dxy', score: -50, detail: '' },
    { id: 'realYields', score: null, detail: 'data unavailable' },
  ]);
  const sum = r.contributions.reduce((a, c) => a + c.contribution, 0);
  assert.ok(Math.abs(sum - r.score) < 1e-9);
  // swing weights trend 20, dxy 12 → (20*100 + 12*-50)/32
  assert.ok(Math.abs(r.score - (2000 - 600) / 32) < 1e-9);
  assert.deepEqual(r.excluded.map((e) => e.id), ['realYields']);
  assert.equal(r.confidence, 'Medium'); // 77% agreement = High, minus one level because >30% of weight is missing
});

test('event risk damps intraday score by 0.6 within 2h', () => {
  const f = [{ id: 'trend' as const, score: 80, detail: '' }, { id: 'momentum' as const, score: 80, detail: '' }];
  const r = combine('intraday', f, { eventRisk: { event: 'USD CPI', ts: new Date().toISOString(), hoursAway: 1 } });
  assert.ok(Math.abs(r.score - 48) < 1e-9);
  assert.equal(r.confidence, 'Low');
});

test('COT contrarian score: crowded longs are bearish', () => {
  const nets = Array.from({ length: 156 }, (_, i) => i); // latest is the maximum
  assert.ok(cotScore(nets).score! <= -55);
});

test('changeZ is positive for an above-normal rise', () => {
  const v = Array.from({ length: 300 }, (_, i) => Math.sin(i / 5));
  v.push(v[v.length - 1] + 3);
  assert.ok(changeZ(v, 1) > 2);
});

test('news classifier', () => {
  assert.equal(classify('Fed signals rate cut as inflation cools').direction, 1);
  assert.equal(classify('Dollar rallies after strong jobs report').direction, -1);
  assert.equal(classify('Missile strikes escalate conflict').topic, 'Geopolitics');
  assert.equal(classify('Local bakery opens new store').impact, 0);
  assert.ok(similarity(normTitle('Gold hits record high - Reuters'), normTitle('Gold hits record high - CNBC')) > 0.85);
});

test('support/resistance zones bracket price', () => {
  const c: Candle[] = [];
  for (let i = 0; i < 200; i++) {
    const x = 100 + 10 * Math.sin(i / 6); // oscillates 90–110
    c.push(bar(i * 3600, x, x + 1, x - 1, x));
  }
  const z = detectZones(c, { fractal: 3 });
  const px = c[c.length - 1].close;
  assert.ok(z.some((q) => q.kind === 'resistance' && q.price > px));
  assert.ok(z.some((q) => q.kind === 'support' && q.price <= px));
  assert.ok(z.every((q) => q.strength >= 0 && q.strength <= 10));
});

test('nyToUtc handles DST', () => {
  assert.equal(nyToUtc(2026, 7, 29, 14, 0).toISOString(), '2026-07-29T18:00:00.000Z'); // EDT
  assert.equal(nyToUtc(2026, 12, 9, 14, 0).toISOString(), '2026-12-09T19:00:00.000Z'); // EST
});
