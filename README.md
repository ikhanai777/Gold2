# Gold Signal Dashboard

Live XAU/USD dashboard built from [SPEC.md](SPEC.md). It shows:

- **Live price:** spot gold, bid/ask, COMEX futures and basis.
- **Factor monitor:** real yields, nominal and 2Y yields, breakevens, Fed funds, CPI, DXY, VIX, GVZ, S&P 500, oil, gold/silver and copper/gold ratios, Bitcoin, CFTC positioning, GLD holdings, geopolitical risk, seasonality and news sentiment.
- **Central chart:** optional support/resistance zones, pivots, Fibonacci, EMAs, Bollinger Bands, VWAP, projected range bands, event markers, and RSI/MACD/ATR panes.
- **Projected ranges:** expected low/high for the day, week and month, with backtested hit rates.
- **Signal board:** Buy/Sell signals for Intraday, Swing and Position, from a transparent weighted score with a "Why?" breakdown.
- **News and calendar:** a classified news feed and an economic calendar.
- **Performance page:** walk-forward backtests and live forward tracking.

**Constraints:** it costs $0 to run, and every value comes from a real source. Nothing is mocked, interpolated or invented. Computed values carry a *Computed* badge, and forecasts carry an *Estimate* badge.

> **Not financial advice.** For information and education only. Signals are probabilistic and can be wrong.

## Quick start

```bash
npm install
npm run build        # builds the frontend into web/dist
npm start            # http://127.0.0.1:8787
```

Development, with hot reload for the UI and the API:

```bash
npm run dev          # UI on http://localhost:5173, API on :8787
```

Self-host with Docker (see SPEC §7.2):

```bash
cp .env.example .env   # optional free keys
docker compose up -d   # http://localhost:8787
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

## Data sources (all free)

| Data | Source | Key |
|---|---|---|
| Spot price | gold-api.com | none |
| Bid/ask | Swissquote public quote feed (unofficial) | none |
| Candles | Twelve Data XAU/USD spot, if a key is set; otherwise Yahoo `GC=F` COMEX futures (unofficial, always labeled as futures) | optional free |
| Spot daily closes | Stooq CSV | none |
| DXY, VIX, GVZ, TNX, oil, copper, silver, S&P 500 | Yahoo Finance spark (unofficial, 1 batched call) | none |
| 10Y real, 10Y and 2Y nominal yields | U.S. Treasury daily yield-curve CSVs (official) | none |
| Breakeven inflation | computed: Treasury 10Y nominal − 10Y real | none |
| Fed funds (EFFR, target) | Federal Reserve Bank of New York API | none |
| CPI | BLS public API v1, or FRED with a key | none / optional |
| CFTC positioning | CFTC Public Reporting (Disaggregated, 088691) | none |
| GLD holdings | SPDR Gold Shares historical archive | none |
| Geopolitical risk | Caldara & Iacoviello daily GPR index | none |
| Bitcoin | Coinbase Exchange public ticker | none |
| News | Google News RSS, Yahoo Finance RSS, Investing.com RSS, BBC World, Fed & ECB press feeds, GDELT, Finnhub (with a key) | none / optional |
| Calendar | Forex Factory weekly JSON (unofficial) + federalreserve.gov FOMC calendar; FRED release dates as fallback | none / optional |

The **Data OK / N sources failing** button in the header lists each provider's last success, last error and calls today against the free-tier cap.

## How signals and ranges work

- **Scores:** each factor gets a score from −100 to +100, where positive is bullish for gold. The horizon score is the weighted mean over the factors that are available. Weights are in [`config/weights.json`](config/weights.json). Unavailable factors are excluded and the rest re-weighted; they are never estimated. Labels use the SPEC thresholds with 5-point hysteresis. An intraday score is damped ×0.6 within 2 hours of a high-impact event.
- **Ranges:** σ = 60% GVZ implied volatility + 40% × an ATR multiple. The multiple is calibrated walk-forward on past periods. The band is centered on the period open, with a skew of up to 0.25σ toward the signal.
- **Support/resistance:** fractal swing points are clustered within 0.25×ATR. Each zone is scored on touches, recency, rejection wicks, round numbers and higher-timeframe confluence.
- **Backtests:** see the Performance page. Only data available at each bar is used. The backtests show that the simple scoring model has **not** beaten buy-and-hold over gold's long bull run. The app reports this rather than hiding it.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | unit tests for the indicator, aggregation, S/R, scoring, classifier and timezone code |
| `npm run typecheck` | TypeScript, server and web |
| `npm run check:integrity` | fails on synthetic-data patterns, paid endpoints, or API keys in the built bundle |
