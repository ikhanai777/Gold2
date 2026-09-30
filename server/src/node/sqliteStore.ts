// SQLite persistence for the Node server (node:sqlite, no native build).
// Stores real fetched data with provenance, plus every published signal/range
// for forward tracking.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../store.js';
import type { Candle } from '../types.js';

export function sqliteStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS candles (
  instrument TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  source TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (instrument, tf, time)
);
CREATE TABLE IF NOT EXISTS usage (provider TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (provider, day));
CREATE TABLE IF NOT EXISTS signal_log (
  ts TEXT NOT NULL, horizon TEXT NOT NULL, score REAL, label TEXT, confidence TEXT, price REAL, instrument TEXT,
  PRIMARY KEY (ts, horizon)
);
CREATE TABLE IF NOT EXISTS range_log (
  period TEXT NOT NULL, period_start TEXT NOT NULL, instrument TEXT NOT NULL,
  open REAL, low REAL, high REAL, ext_low REAL, ext_high REAL, published_at TEXT,
  PRIMARY KEY (period, period_start, instrument)
);
CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY, ts TEXT, title TEXT, url TEXT, source TEXT, feed TEXT, snippet TEXT,
  topic TEXT, direction INTEGER, impact INTEGER, rationale TEXT, fetched_at TEXT
);
`);

  const upsertCandle = db.prepare(`INSERT INTO candles (instrument, tf, time, open, high, low, close, volume, source, fetched_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(instrument, tf, time) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low,
  close=excluded.close, volume=excluded.volume, source=excluded.source, fetched_at=excluded.fetched_at`);
  const getUsage = db.prepare('SELECT count FROM usage WHERE provider=? AND day=?');
  const bumpUsage = db.prepare('INSERT INTO usage (provider, day, count) VALUES (?, ?, 1) ON CONFLICT(provider, day) DO UPDATE SET count = count + 1');
  const insertNews = db.prepare(`INSERT OR IGNORE INTO news (id, ts, title, url, source, feed, snippet, topic, direction, impact, rationale, fetched_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const logSignal = db.prepare('INSERT OR REPLACE INTO signal_log (ts, horizon, score, label, confidence, price, instrument) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const logRange = db.prepare('INSERT OR IGNORE INTO range_log (period, period_start, instrument, open, low, high, ext_low, ext_high, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  return {
    usageGet: (p, d) => (getUsage.get(p, d) as { count: number } | undefined)?.count ?? 0,
    usageBump: (p, d) => { bumpUsage.run(p, d); },
    saveCandles(instrument: string, tf: string, candles: Candle[], source: string) {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        for (const c of candles) upsertCandle.run(instrument, tf, c.time, c.open, c.high, c.low, c.close, c.volume ?? null, source, now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    loadCandles(instrument, tf, sinceSec) {
      const rows = db
        .prepare('SELECT time, open, high, low, close, volume FROM candles WHERE instrument=? AND tf=? AND time>=? ORDER BY time')
        .all(instrument, tf, sinceSec) as unknown as Candle[];
      return rows.map((r) => ({ ...r, volume: r.volume ?? undefined }));
    },
    insertNews: (n) => {
      insertNews.run(n.id, n.ts, n.title, n.url, n.source, n.feed, n.snippet, n.topic, n.direction, n.impact, n.rationale, new Date().toISOString());
    },
    logSignal: (r) => { logSignal.run(r.ts, r.horizon, r.score, r.label, r.confidence, r.price, r.instrument); },
    lastSignalLabel: (h) => (db.prepare('SELECT label FROM signal_log WHERE horizon=? ORDER BY ts DESC LIMIT 1').get(h) as { label: string } | undefined)?.label ?? null,
    signalHistory: (h, since) =>
      db.prepare('SELECT ts, label, score FROM signal_log WHERE horizon=? AND ts>=? ORDER BY ts').all(h, since) as { ts: string; label: string; score: number }[],
    recentSignals: (n) => db.prepare('SELECT * FROM signal_log ORDER BY ts DESC LIMIT ?').all(n) as unknown as ReturnType<Store['recentSignals']>,
    logRange: (r) => { logRange.run(r.period, r.periodStart, r.instrument, r.open, r.low, r.high, r.extLow, r.extHigh, r.publishedAt); },
    recentRanges: (n) =>
      (db.prepare('SELECT * FROM range_log ORDER BY period_start DESC LIMIT ?').all(n) as any[]).map((r) => ({
        period: r.period, periodStart: r.period_start, instrument: r.instrument, open: r.open, low: r.low, high: r.high,
        extLow: r.ext_low, extHigh: r.ext_high, publishedAt: r.published_at,
      })),
  };
}
