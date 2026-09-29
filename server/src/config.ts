// Runtime configuration. All API keys are optional free-tier keys; the app
// runs without any of them and degrades the affected widgets to "unavailable".
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependency). Real environment variables win.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? resolve(process.cwd(), 'data/gold.db'),
  keys: {
    twelveData: process.env.TWELVEDATA_API_KEY || '',
    fred: process.env.FRED_API_KEY || '',
    finnhub: process.env.FINNHUB_API_KEY || '',
  },
  // Daily request caps, deliberately below each provider's free limit (SPEC §4.5).
  dailyCaps: {
    'gold-api': num(process.env.CAP_GOLDAPI, 9000),
    swissquote: num(process.env.CAP_SWISSQUOTE, 6000),
    twelvedata: num(process.env.CAP_TWELVEDATA, 700),
    fred: num(process.env.CAP_FRED, 500),
    finnhub: num(process.env.CAP_FINNHUB, 2000),
    gdelt: num(process.env.CAP_GDELT, 400),
    yahoo: num(process.env.CAP_YAHOO, 2500),
    treasury: 100,
    stooq: 20,
    cftc: 20,
    gld: 20,
    gpr: 10,
    coinbase: 2000,
    rss: 3000,
    forexfactory: 100,
    fomc: 10,
    nyfed: 50,
    bls: 20,
  } as Record<string, number>,
};

export type ProviderId = keyof typeof config.dailyCaps;
