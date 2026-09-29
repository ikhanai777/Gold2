export interface Candle {
  time: number; // bar open, unix seconds UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';
export const TF_SECONDS: Record<Timeframe, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

export type Freshness = 'live' | 'delayed' | 'stale' | 'unavailable';

/** Provenance attached to every value served to the UI (SPEC §1.4). */
export interface Provenance {
  source: string;
  ts: string | null; // provider's own observation timestamp (ISO)
  fetchedAt: string | null;
  status: Freshness;
  computed?: boolean;
  inputs?: string[];
  note?: string;
}

export interface SeriesPoint { date: string; value: number } // date = YYYY-MM-DD

export type Direction = 1 | -1 | 0;
