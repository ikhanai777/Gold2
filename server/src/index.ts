// Gold Signal Dashboard backend: one always-on Node process that polls free
// data sources, computes analytics and serves the API + SSE + built frontend.
import { serverConfig } from './node/env.js'; // must be first: loads .env, store and transport
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import {
  analysisInstrument, availableInstruments, candlesPayload, computePerformance, computeRanges, computeSignals,
  factorsPayload, levelsPayload, performancePayload, quotePayload, rangesPayload, signalsPayload, statusPayload,
} from './analytics.js';
import { onEvent, startJobs } from './jobs.js';
import { INSTRUMENTS, state, type InstrumentId } from './state.js';
import type { Timeframe } from './types.js';

const app = Fastify({ logger: false });
const TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; script-src 'self'",
  );
  return payload;
});

// Simple per-IP rate limit for the API.
const hits = new Map<string, { n: number; reset: number }>();
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/') || req.url.startsWith('/api/stream')) return;
  const k = req.ip;
  const h = hits.get(k);
  if (!h || h.reset < Date.now()) hits.set(k, { n: 1, reset: Date.now() + 60_000 });
  else if (++h.n > 600) return reply.code(429).send({ error: 'rate limited' });
});

const pickInst = (q: any): InstrumentId | null => {
  const i = q?.instrument as InstrumentId | undefined;
  if (i && i in INSTRUMENTS) return i;
  return analysisInstrument() ?? availableInstruments()[0] ?? null;
};
const pickTf = (q: any): Timeframe => (TFS.includes(q?.tf) ? q.tf : '1h');

app.get('/api/status', async () => statusPayload());
app.get('/api/quote', async () => quotePayload());
app.get('/api/candles', async (req, reply) => {
  const inst = pickInst(req.query);
  const p = inst && candlesPayload(inst, pickTf(req.query), Math.min(5000, Number((req.query as any).limit) || 1500));
  if (!p) return reply.code(503).send({ error: 'Candles not loaded yet or source unavailable' });
  return p;
});
app.get('/api/levels', async (req, reply) => {
  const inst = pickInst(req.query);
  if (!inst) return reply.code(503).send({ error: 'no instrument available yet' });
  return levelsPayload(inst, pickTf(req.query));
});
app.get('/api/factors', async () => ({ factors: factorsPayload() }));
app.get('/api/signals', async () => signalsPayload());
app.get('/api/ranges', async () => rangesPayload());
app.get('/api/news', async (req) => {
  const q = req.query as { topic?: string; minImpact?: string };
  const min = Number(q.minImpact) || 0;
  const items = state.news.filter((n) => (!q.topic || n.topic === q.topic) && n.impact >= min);
  return { items: items.slice(0, 200), feeds: Object.fromEntries(state.newsFetchedAt), computedTags: true };
});
app.get('/api/calendar', async (req) => {
  const days = Math.min(14, Number((req.query as any).days) || 7);
  const from = Date.now() - 12 * 3600e3, to = Date.now() + days * 86400e3;
  return {
    source: state.calendarSource, fetchedAt: state.calendarFetchedAt,
    events: state.calendar.filter((e) => Date.parse(e.ts) >= from && Date.parse(e.ts) <= to),
  };
});
app.get('/api/performance', async () => performancePayload());

// Server-sent events: quote ticks + "something changed" notifications.
app.get('/api/stream', (req, reply) => {
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  send('hello', { ts: new Date().toISOString() });
  const off = onEvent(send);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  req.raw.on('close', () => { off(); clearInterval(ping); });
});

const dist = resolve(process.cwd(), 'web/dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
}

let lastPerf = 0;
startJobs(() => {
  computeSignals();
  computeRanges();
  if (Date.now() - lastPerf > 12 * 3600e3 || (!performancePayload().backtests.length && Date.now() - lastPerf > 5 * 60e3)) {
    lastPerf = Date.now();
    setImmediate(() => {
      try { computePerformance(); } catch (e) { console.error('[performance]', e); }
      if (!performancePayload().backtests.length) lastPerf = 0; // retry once data arrives
    });
  }
});
onEvent((ev) => { if (ev === 'candles') { computeSignals(); } });

await app.listen({ port: serverConfig.port, host: serverConfig.host });
console.log(`Gold Signal Dashboard API on http://${serverConfig.host}:${serverConfig.port}${existsSync(dist) ? ' (serving web/dist)' : ''}`);
console.log(`Keys: TwelveData=${!!config.keys.twelveData} FRED=${!!config.keys.fred} Finnhub=${!!config.keys.finnhub} (all optional, free)`);
