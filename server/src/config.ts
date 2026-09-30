// Platform-neutral runtime configuration. All API keys are optional free-tier
// keys; the app runs without any of them and degrades the affected widgets to
// "unavailable". The Node server fills this from .env/process.env (node/env.ts);
// the Android app fills it from its Settings screen.

export const config = {
  keys: { twelveData: '', fred: '', finnhub: '' },
  // Daily request caps, deliberately below each provider's free limit (SPEC §4.5).
  dailyCaps: {
    'gold-api': 9000,
    swissquote: 6000,
    twelvedata: 700,
    fred: 500,
    finnhub: 2000,
    gdelt: 400,
    yahoo: 2500,
    treasury: 300,
    stooq: 20,
    cftc: 20,
    gld: 20,
    gpr: 10,
    coinbase: 2000,
    rss: 600, // per feed (rss:<feed>)
    forexfactory: 100,
    fomc: 10,
    nyfed: 50,
    bls: 20,
  } as Record<string, number>,
};

export type ProviderId = keyof typeof config.dailyCaps;

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

/** Apply key/cap settings from an environment-like map (process.env or app settings). */
export function applySettings(env: Record<string, string | undefined>) {
  config.keys.twelveData = (env.TWELVEDATA_API_KEY ?? '').trim();
  config.keys.fred = (env.FRED_API_KEY ?? '').trim();
  config.keys.finnhub = (env.FINNHUB_API_KEY ?? '').trim();
  const caps: Record<string, string> = {
    'gold-api': 'CAP_GOLDAPI', swissquote: 'CAP_SWISSQUOTE', twelvedata: 'CAP_TWELVEDATA', fred: 'CAP_FRED',
    finnhub: 'CAP_FINNHUB', gdelt: 'CAP_GDELT', yahoo: 'CAP_YAHOO',
  };
  for (const [p, k] of Object.entries(caps)) config.dailyCaps[p] = num(env[k], config.dailyCaps[p]);
}
