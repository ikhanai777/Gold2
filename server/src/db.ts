// SQLite persistence (node:sqlite, no native build). Stores real fetched data
// with provenance, plus every published signal/range for forward tracking.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import type { Candle } from './types.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
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

export function saveCandles(instrument: string, tf: string, candles: Candle[], source: string) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const c of candles) upsertCandle.run(instrument, tf, c.time, c.open, c.high, c.low, c.close, c.volume ?? null, source, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function loadCandles(instrument: string, tf: string, sinceSec = 0): Candle[] {
  const rows = db
    .prepare('SELECT time, open, high, low, close, volume FROM candles WHERE instrument=? AND tf=? AND time>=? ORDER BY time')
    .all(instrument, tf, sinceSec) as unknown as Candle[];
  return rows.map((r) => ({ ...r, volume: r.volume ?? undefined }));
}
