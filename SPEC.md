# Gold Signal Dashboard: Product & Technical Specification

**Version:** 1.0 (draft)
**Date:** 2026-09-29
**Status:** Proposed

---

## 1. Overview

A single-page web dashboard for XAU/USD (spot gold). It pulls **live, real market data from public APIs**, tracks the macro and market factors that drive gold, shows a news feed of events that could move it, and turns all of that into:

1. A **central interactive gold chart** with optional support/resistance overlays.
2. **Projected price ranges** (expected low/high) for the **day, week and month**.
3. A **Buy/Sell Signal Board** driven by a transparent, weighted scoring model.

> **Disclaimer (shown in the UI):** The dashboard is for information and education only and is not financial advice. Signals are probabilistic and can be wrong.

### 1.1 Goals
- Show real data only: no mocked prices in production. Every number shows its source and a "last updated" timestamp.
- Explain every signal: the user can see which factors pushed the score up or down.
- Measure predictions: range forecasts and signals are logged and backtested, and the hit rates are shown in the app.

### 1.2 Non-goals (v1)
- Order execution or broker integration.
- User accounts or portfolios (optional in v2).
- Assets other than gold. Silver, oil and others appear only as factor inputs.

---

## 2. Users & Key Use Cases

| User | Need |
|---|---|
| Retail trader | "Should I lean long or short today? Where are the key levels?" |
| Swing trader | "What's the weekly bias and expected range?" |
| Long-term buyer | "Is now a relatively good time to accumulate?" (monthly view) |
| News-driven trader | "What just happened, and is it bullish or bearish for gold?" |

---

## 3. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HEADER: XAU/USD 2,xxx.xx ▲+12.40 (+0.5%) │ Bid/Ask │ Session │ Data status │
├───────────────┬──────────────────────────────────────┬───────────────────┤
│ FACTOR        │                                      │ SIGNAL BOARD      │
│ MONITOR       │        MAIN GOLD CHART               │  Intraday: BUY 64 │
│ DXY  ▼ bull   │  [1m 5m 15m 1H 4H 1D 1W]             │  Swing:  NEUTRAL  │
│ 10Y real ▲    │  [☐ S/R] [☐ Pivots] [☐ Fib] [☐ MAs]   │  Position: BUY 41 │
│ VIX / GVZ     │  [☐ Expected range bands]            │  Top drivers ...  │
│ Breakevens    │                                      ├───────────────────┤
│ Oil, Silver   │                                      │ PROJECTED RANGES  │
│ COT, ETF flow │                                      │  Day  L / H       │
│ ...           ├──────────────────────────────────────┤  Week L / H       │
│               │ TECHNICAL STRIP: RSI · MACD · ATR    │  Month L / H      │
├───────────────┴──────────────────────────────────────┴───────────────────┤
│ NEWS FEED (impact-tagged)            │ ECONOMIC CALENDAR (next 7 days)    │
└──────────────────────────────────────┴───────────────────────────────────┘
```

- **Responsive:** on mobile the order is Header → Signal Board → Chart → Ranges → Factors → News → Calendar.
- **Theme:** dark by default ("trading terminal" look with gold accents), plus a light mode.
- **Colors:** bullish = green, bearish = red, neutral = gray/amber. Color is never the only cue; ▲/▼ arrows and labels are always shown too.

---

## 4. Data Sources (real, public)

All third-party calls go through **our backend**, which keeps API keys server-side, caches responses and stays inside rate limits. The browser never calls a keyed API directly.

### 4.1 Gold price

| Purpose | Primary | Fallback | Notes |
|---|---|---|---|
| Live spot quote | **gold-api.com** `GET https://api.gold-api.com/price/XAU` (free, no key) | GoldAPI.io (free key), Metals.dev (free key) | Poll every 15–30 s on the backend and push to clients over SSE/WebSocket |
| Intraday OHLC (1m–4H) | **Twelve Data** `time_series?symbol=XAU/USD` (free key, ~800 req/day) | Yahoo Finance chart endpoint `GC=F` (unofficial; COMEX futures) | Cache per interval |
| Daily/weekly history (10+ yrs) | **Stooq CSV** `https://stooq.com/q/d/l/?s=xauusd&i=d` (free) | Twelve Data daily | Used for backtests, pivots, volatility |
| Futures volume (for volume profile) | Yahoo `GC=F` (unofficial) | n/a | Spot gold has no central volume, so futures volume is used as a proxy |

### 4.2 Macro & cross-asset factors

| Factor | Source | Series / Endpoint | Refresh |
|---|---|---|---|
| 10Y real yield (TIPS) | **FRED API** (free key) | `DFII10` | Daily |
| 10Y nominal yield | FRED | `DGS10` (+ intraday `^TNX` via Yahoo, optional) | Daily / 1 min |
| 2Y yield (Fed expectations proxy) | FRED | `DGS2` | Daily |
| 10Y breakeven inflation | FRED | `T10YIE` | Daily |
| US Dollar | Yahoo `DX-Y.NYB` (DXY, intraday) | FRED `DTWEXBGS` (broad dollar, daily) | 1 min / daily |
| Gold implied volatility | FRED | `GVZCLS` (CBOE Gold ETF Volatility Index) | Daily |
| Equity risk sentiment | FRED `VIXCLS`; Yahoo `^VIX`, `^GSPC` | | 1 min / daily |
| Fed funds rate | FRED | `FEDFUNDS`, `DFEDTARU` | On change |
| CPI / Core CPI | FRED | `CPIAUCSL`, `CPILFESL` | Monthly |
| Crude oil | FRED `DCOILWTICO`; Yahoo `CL=F` | | Daily / 1 min |
| Silver (gold/silver ratio) | gold-api.com `/price/XAG` | | 30 s |
| Copper (copper/gold ratio) | Yahoo `HG=F` | | 1 min |
| Bitcoin (competing "hard asset") | Crypto.com / Coinbase public ticker | | 30 s |
| CFTC positioning (managed money) | **CFTC Public Reporting API** (Socrata), Disaggregated Futures-Only, market code `088691` (Gold, COMEX) | | Weekly (Fri) |
| Gold ETF holdings | SPDR Gold Shares (GLD) published historical holdings CSV (tonnes) | | Daily |
| Geopolitical risk | Caldara–Iacoviello **GPR Index** (daily CSV, matteoiacoviello.com) + GDELT tone (below) | | Daily |
| Central bank buying | World Gold Council reports (no API, entered manually/quarterly) | | Quarterly |
| Seasonality | Computed from Stooq history | | Static, recomputed monthly |

### 4.3 News & events

| Purpose | Source | Notes |
|---|---|---|
| Global news stream | **GDELT DOC 2.0 API** (free, no key) with query terms such as `gold OR "Federal Reserve" OR inflation OR "central bank" OR sanctions OR war OR tariff` | Returns articles plus tone; refresh every 5 min |
| Market headlines | **Finnhub** `/news?category=general` and `forex` (free key) | Refresh every 2 min |
| Optional | NewsAPI.org (dev key; not licensed for production), RSS from central banks (Fed, ECB press releases) | |
| Economic calendar | Forex Factory weekly JSON (`nfs.faireconomy.media/ff_calendar_thisweek.json`, unofficial) | Fallback: Finnhub economic calendar (paid tier) or a manually curated list of FOMC/CPI/NFP dates |

### 4.4 Data-quality rules
- Every widget shows a **source label** and a **freshness badge**: 🟢 live (< 2× expected interval), 🟡 delayed, 🔴 stale/failed.
- If the primary source fails, switch to the fallback automatically and note it in the header's data status.
- **Sanity checks:** reject a tick that moves more than 3% from the last good price within 1 minute unless a second source confirms it.
- Mark weekend/market-closed periods (gold trades roughly Sun 18:00 to Fri 17:00 ET, with a daily 17:00–18:00 ET break).
- Respect each provider's terms of service. Unofficial endpoints (Yahoo, Forex Factory) must be replaceable behind a provider interface.

---

## 5. Feature Specifications

### 5.1 Header / Live Ticker
- Spot price (2 decimals), absolute and % change against the previous NY close, day high/low, bid/ask when available.
- The price flashes green or red on each tick.
- Current session (Asia / London / New York / Closed) with a countdown to the next session open.
- Data status indicator (see 4.4).

### 5.2 Main Gold Chart (center)
**Library:** TradingView **Lightweight Charts** (Apache-2.0), which is fast, canvas-based and supports candlesticks and overlays.

**Base features**
- Candlestick (default), line and area modes.
- Timeframes: 1m, 5m, 15m, 1H, 4H, 1D, 1W.
- Crosshair with an OHLC tooltip, zoom/pan, auto-scale and log scale.
- The live tick updates the last candle in real time.
- A volume sub-pane (futures proxy) that can be toggled.

**Toggleable overlays** (checkboxes; state saved in `localStorage`)

| Overlay | Method |
|---|---|
| **Support / Resistance (S/R)** | See algorithm 6.1. Drawn as horizontal zones (bands, not single lines), with opacity scaled by strength and a label such as `R2 2,418 (strength 8)` |
| **Pivot points** | Classic, Fibonacci or Camarilla (selectable), computed from the previous day/week/month |
| **Fibonacci retracements** | Auto-anchored to the most recent significant swing high/low on the visible range |
| **Moving averages** | EMA 20/50/200 (configurable) |
| **Bollinger Bands** | 20, 2σ |
| **VWAP** | Session VWAP (intraday frames only; futures volume proxy) |
| **Expected range bands** | Day/week/month projected low/high from 5.4, drawn as dashed lines |
| **Event markers** | Flags on the time axis for high-impact calendar events and major news spikes |

**Technical strip** (below the chart, synced crosshair): RSI(14), MACD(12,26,9), ATR(14). Each can be collapsed.

### 5.3 Factor Monitor (left panel)
Each factor is a card with:
- Current value, change (1D / 1W), and a 30-day sparkline.
- **Gold impact tag:** Bullish / Bearish / Neutral for gold, derived from the factor's direction and its known relationship with gold (see table).
- A **30-day rolling correlation** with gold, so the user can see when a relationship weakens or flips.
- A tooltip explaining why the factor matters.

| Factor | Typical relationship with gold |
|---|---|
| US real yields (DFII10) | **Strong inverse.** Higher real yields raise the opportunity cost of holding gold |
| US Dollar (DXY) | **Inverse.** Gold is priced in USD |
| Fed policy expectations (2Y yield) | Rate-cut expectations are bullish |
| Inflation breakevens | Rising inflation expectations are usually bullish |
| VIX / risk-off | Spikes in fear are usually bullish (safe haven), though forced selling can briefly hit gold in a crash |
| Geopolitical risk (GPR, GDELT tone) | Rising risk is bullish |
| GVZ (gold implied vol) | Not directional; scales the expected ranges |
| CFTC managed-money net longs | **Contrarian at extremes.** Very crowded longs are a bearish risk |
| ETF holdings (GLD tonnes) | Inflows are bullish |
| Central bank purchases | Sustained buying is bullish (structural) |
| Oil | Mildly positive (inflation channel) |
| Gold/Silver ratio, Copper/Gold ratio | Growth and risk-appetite context |
| Equities (S&P 500) | Varies; watch the rolling correlation |
| Seasonality | Historical average return for the current month/week |

### 5.4 Projected Ranges (predicted Low / High)
Shows, for **Today**, **This Week** and **This Month**:
- **Expected Low / Expected High** (about a 68% band) and an **Extended Low / High** (about a 95% band).
- The method used, the **historical hit rate** (the share of past periods that closed inside the band), and the model's confidence.

**Method (ensemble, see 6.2):**
1. **Implied-volatility move:** `σ_period = Price × (GVZ/100) × √(tradingDays/252)`.
2. **ATR projection:** from the period's open, ± k × ATR (k is calibrated on history).
3. **Pivot / S/R confluence:** nudges the band edges toward strong S/R levels that sit nearby.
4. **Directional skew:** the band midpoint shifts slightly toward the Signal Board bias, capped at ±0.25σ.

The ensemble is a weighted mean of (1) and (2), with (3) and (4) applied as adjustments. Bands are fixed at the period open (so they can be backtested) and shown next to the live price.

### 5.5 Buy / Sell Signal Board (right panel)
One card per horizon:

| Horizon | Chart basis | Used for |
|---|---|---|
| **Intraday** | 15m / 1H | Day traders |
| **Swing** | 4H / 1D (days to weeks) | Swing traders |
| **Position** | 1D / 1W (weeks to months) | Investors |

Each card shows:
- A **score from −100 to +100**, drawn as a gauge.
- A **label** from the thresholds below.
- A **confidence** (Low/Med/High), based on how strongly the factors agree and on data freshness.
- The **top 3 bullish and top 3 bearish drivers** with their point contributions.
- An **event-risk warning** when a high-impact event (FOMC, CPI, NFP, PCE, major geopolitical event) falls within the horizon window.
- **Suggested reference levels:** nearest support (a possible entry or stop for longs), nearest resistance (a target), and ATR-based stop distance. These are labeled "reference levels, not advice."
- The time of the last signal change and its history (a 30-day timeline of labels).

**Thresholds**

| Score | Label |
|---|---|
| ≥ +60 | **STRONG BUY** |
| +20 … +59 | **BUY** |
| −19 … +19 | **NEUTRAL** |
| −59 … −20 | **SELL** |
| ≤ −60 | **STRONG SELL** |

To stop the label flickering near a boundary, a label only changes once the score crosses the threshold by 5 points (hysteresis).

A **"Why?" drawer** lists every factor with its raw value, normalized score, weight and contribution, so the result is fully transparent.

### 5.6 News Feed
- A reverse-chronological list merging GDELT and Finnhub, with duplicates removed (URL plus title similarity above 0.85).
- Each item shows the headline, source, time ago, a short snippet, and these tags:
  - **Topic:** Fed/Rates, Inflation, USD, Geopolitics, Central Banks, Physical Demand (India/China), ETFs, Mining/Supply, Other.
  - **Gold impact:** Bullish / Bearish / Neutral, with an **impact score from 0 to 5**.
- **Classification:** v1 uses a keyword/rules engine plus the GDELT tone score. v2 uses an LLM classifier on the backend (headline and snippet only) that returns `{topic, direction, impact, one-line rationale}`, cached per article.
- Filters by topic and impact, plus a "High impact only" toggle.
- A **news sentiment index**: the 24-hour rolling average of impact × direction, fed into the scoring model.
- High-impact items appear as markers on the chart (5.2).

### 5.7 Economic Calendar
- The next 7 days of events that matter for USD and gold: FOMC, CPI, PCE, NFP, GDP, ISM, jobless claims, Fed speakers, and ECB/BoJ/PBoC decisions.
- Shows time (in the user's timezone), impact (low/med/high), forecast, previous, and actual once released.
- A countdown to the next high-impact event.
- Once an event is released, the surprise (actual − forecast) is tagged bullish or bearish for gold using a rules table (for example, CPI above forecast means hawkish, which is bearish in the short term).

### 5.8 Performance / Transparency page
- A backtest of each signal horizon over 5+ years of history: hit rate, average forward return by label, max drawdown of a simple "follow the signal" strategy, and a comparison with buy-and-hold.
- Range-forecast calibration: how often price actually stayed inside the 68% and 95% bands.
- A live forward-tracking log of every signal and range published since launch.

---

## 6. Algorithms

### 6.1 Support & Resistance detection
1. **Swing points:** find fractal highs and lows (a bar whose high/low is the extreme within N bars on each side, where N = 3/5/10 depending on timeframe) over a lookback of 200–500 bars.
2. **Clustering:** group swing prices within `0.25 × ATR(14)` of each other into zones (1-D DBSCAN or greedy merging).
3. **Strength score** for each zone:
   `strength = touches × 2 + recency_weight + rejection_wick_bonus + round_number_bonus (e.g., 2,400 / 2,450) + volume_profile_bonus (high-volume node)`
4. Keep the top K zones (default 3 above price and 3 below), labeled R1..R3 and S1..S3 by distance from price.
5. **Multi-timeframe confluence:** a zone that also appears on a higher timeframe gets a ×1.5 strength bonus.
6. Recompute on every closed candle of the active timeframe.

### 6.2 Range projection
- `σ_IV = P × GVZ/100 × √(d/252)` where d = 1 (day), 5 (week) or about 21 (month).
- `σ_ATR = k_d × ATR_d`, with k_d fitted so that ±1σ_ATR covers about 68% of historical period ranges.
- `σ = w·σ_IV + (1−w)·σ_ATR` (default w = 0.6; falls back to ATR only if GVZ is stale).
- `mid = Open_period + skew`, where `skew = clamp(score/100, −1, 1) × 0.25σ`.
- Expected band = mid ± σ. Extended band = mid ± 2σ.
- Snap: if a strength ≥ 7 S/R zone lies within 0.2σ of a band edge, move the edge onto the zone.

### 6.3 Scoring model
Each factor is normalized to a **sub-score in [−100, +100]** (positive means bullish for gold), then combined with horizon-specific weights:

`Score_h = Σ (w_{h,i} × s_i) / Σ w_{h,i}`, clamped to [−100, +100].

**Technical sub-scores**
| Component | Rule (example) |
|---|---|
| Trend | Price vs EMA20/50/200 and EMA slope. Full bull stack = +100, full bear stack = −100 |
| Momentum | MACD histogram sign and slope. RSI: 50–70 = mildly bullish; > 70 = overbought fade (reduces the score); < 30 = oversold bounce potential |
| Trend strength | ADX > 25 amplifies the trend score ×1.2; ADX < 20 damps it ×0.7 |
| Price vs S/R | Near strong support = +; near strong resistance = −; a confirmed breakout above resistance = strong + |
| Volatility regime | Bollinger squeeze: not directional, but raises the "breakout pending" flag |

**Fundamental / macro sub-scores** (z-score of the 5-day or 20-day change against a 1-year history, mapped with `s = clamp(−z × 40, −100, 100)` for inverse factors and `+z × 40` for positive ones)
| Component | Direction |
|---|---|
| Real yields Δ | inverse |
| DXY Δ | inverse |
| 2Y yield Δ (Fed expectations) | inverse |
| Breakevens Δ | positive |
| VIX level/Δ | positive (risk-off) |
| Geopolitical risk (GPR + GDELT tone) | positive |
| ETF holdings Δ (tonnes) | positive |
| CFTC managed-money net long percentile | contrarian: > 90th pct = −60, < 10th pct = +60, linear between |
| News sentiment index | positive (±100 scaled) |
| Seasonality | ± up to 30 |

**Default weights (%)**

| Factor | Intraday | Swing | Position |
|---|---|---|---|
| Trend | 20 | 20 | 15 |
| Momentum | 20 | 12 | 5 |
| Price vs S/R | 15 | 10 | 5 |
| Real yields | 5 | 12 | 18 |
| DXY | 12 | 12 | 10 |
| Fed expectations (2Y) | 5 | 8 | 10 |
| Breakevens | 0 | 3 | 7 |
| VIX / risk | 8 | 5 | 3 |
| Geopolitical risk | 3 | 5 | 7 |
| ETF flows | 0 | 4 | 7 |
| CFTC positioning | 0 | 4 | 6 |
| News sentiment | 12 | 5 | 2 |
| Seasonality | 0 | 0 | 5 |
| **Total** | **100** | **100** | **100** |

**Modifiers**
- **Event risk:** within 2 hours before a high-impact event, the intraday confidence drops to Low and the score is multiplied by 0.6.
- **Staleness:** any factor with stale data gets its weight set to 0 and the remaining weights are re-normalized. The factor is shown as "excluded."
- **Agreement → confidence:** confidence is High if more than 70% of the weighted contribution points the same way, Low if less than 55%.

**Calibration:** weights are config-driven (`config/weights.json`) and tuned with walk-forward optimization on history (train 3 years, test 1 year, rolling). Maximizing the in-sample hit rate is forbidden. Out-of-sample results are the ones reported on the Performance page.

---

## 7. Architecture

```
            ┌───────────────────────── Browser ─────────────────────────┐
            │ Next.js (React, TypeScript) · Lightweight Charts · Zustand │
            │ TanStack Query (REST)  +  SSE/WebSocket (live ticks)       │
            └──────────────────────────────┬─────────────────────────────┘
                                           │ HTTPS
            ┌──────────────────────────────▼─────────────────────────────┐
            │ Backend API (Next.js route handlers or Node/Fastify)        │
            │  • Provider adapters (price, macro, news, calendar)         │
            │  • Scheduler/pollers (cron + interval jobs)                 │
            │  • Engines: indicators, S/R, ranges, scoring, news classify │
            │  • Cache: Redis (hot) · Postgres/TimescaleDB (history, logs)│
            └──────────────────────────────┬─────────────────────────────┘
                                           │
     gold-api.com · Twelve Data · Stooq · FRED · Yahoo · CFTC · GDELT · Finnhub · FF calendar
```

- **Language:** TypeScript end to end. Indicator math lives in a shared, unit-tested package (`packages/analytics`).
- **Provider adapter interface:** `getQuote()`, `getCandles(tf, from, to)`, `getSeries(id)`, `getNews(since)`. Each adapter has its own retry, backoff and fallback chain.
- **Caching TTLs:** quote 15 s · intraday candles 60 s · FRED 1 h · CFTC 24 h · news 2–5 min · calendar 30 min.
- **Live push:** the backend polls the price once and fans it out to all clients over SSE, so client count doesn't multiply API usage.
- **Persistence:** candles, factor snapshots, every published signal and range (for forward tracking), and classified news.
- **Secrets:** API keys live only in environment variables (`TWELVEDATA_API_KEY`, `FRED_API_KEY`, `FINNHUB_API_KEY`, …) and are never shipped to the client.
- **Deployment:** Vercel/Fly.io/Render with a managed Redis and Postgres. Scheduled jobs run via platform cron.

### 7.1 Internal API (backend → frontend)

| Endpoint | Returns |
|---|---|
| `GET /api/quote` | `{price, bid, ask, change, changePct, high, low, source, ts}` |
| `GET /api/stream` | SSE stream of quote ticks and signal updates |
| `GET /api/candles?tf=1h&limit=500` | OHLCV array |
| `GET /api/levels?tf=1h` | `{support:[{price, low, high, strength}], resistance:[…], pivots:{…}, fib:{…}}` |
| `GET /api/ranges` | `{day:{low, high, extLow, extHigh, method, hitRate}, week:{…}, month:{…}}` |
| `GET /api/factors` | array of `{id, name, value, change1d, change1w, spark[], impact, corr30d, source, ts, status}` |
| `GET /api/signals` | `{intraday:{score, label, confidence, drivers[], eventRisk, levels}, swing:{…}, position:{…}, ts}` |
| `GET /api/news?topic=&minImpact=` | array of `{id, title, url, source, ts, snippet, topic, direction, impact, rationale}` |
| `GET /api/calendar?days=7` | array of `{ts, country, event, impact, forecast, previous, actual, goldBias}` |
| `GET /api/performance` | backtest and forward-tracking stats |

---

## 8. Non-Functional Requirements
- **Performance:** first contentful paint under 2 s. Chart renders 5,000 candles at 60 fps. Tick-to-screen latency under 1 s after the backend receives the tick.
- **Reliability:** every widget degrades on its own. One failed provider never blanks the page.
- **Accuracy:** no fabricated values. If a value is unavailable, the UI shows "—" with a reason.
- **Accessibility:** WCAG 2.1 AA contrast, keyboard-navigable toggles, screen-reader labels on gauges ("Swing signal: Buy, score 34").
- **Security:** keys server-side only, per-IP rate limiting on the API, CSP headers, sanitized news HTML.
- **Compliance:** attribute each data provider as its terms require. Show the not-financial-advice disclaimer persistently in the footer and on the Signal Board.
- **Observability:** structured logs, provider error-rate metrics, and alerts when a source stays stale for more than 10 minutes.

---

## 9. Optional / v2
- User alerts (email, push, Telegram) on signal label changes, price crossing S/R, or high-impact news.
- An ML forecaster (gradient boosting on the factor set) for next-day direction probability, shown next to the rules score and only after it beats the rules model out of sample.
- Multi-currency gold (XAU in EUR, INR, CNY, AED) and local premiums (Shanghai Gold Exchange premium as a China demand gauge).
- A user-adjustable weight editor ("build your own score") with an instant backtest.
- PWA / mobile app.

---

## 10. Milestones

| Phase | Scope | Est. |
|---|---|---|
| M1 | Repo scaffold, provider adapters, live quote + chart (candles, timeframes) | 1 wk |
| M2 | Indicators, S/R engine, pivots/Fib overlays, toggles | 1 wk |
| M3 | Factor Monitor (FRED, DXY, VIX, GVZ, CFTC, ETF, GPR) | 1 wk |
| M4 | News feed + calendar + rules classifier + sentiment index | 1 wk |
| M5 | Scoring engine, Signal Board, range projections | 1 wk |
| M6 | Backtest/Performance page, calibration, hardening, deploy | 1–2 wk |

---

## 11. Acceptance Criteria
1. The header price matches a reference source (e.g., gold-api.com or Kitco) within $1 during market hours and updates at least every 30 s.
2. The chart shows real XAU/USD candles for all 7 timeframes, and the live candle updates in place.
3. Each overlay (S/R, pivots, Fib, MAs, Bollinger, range bands) can be toggled on and off independently, and the setting survives a page reload.
4. The Factor Monitor shows at least 10 live factors, each with source, timestamp, impact tag and 30-day correlation.
5. The news feed shows items less than 15 minutes old during active news hours, each tagged with topic and impact.
6. The Signal Board shows three horizons, each with score, label, confidence, top drivers and an event-risk warning when applicable. The "Why?" drawer's contributions add up to the displayed score.
7. Projected day/week/month ranges are shown with their method and a historical hit rate. The 68% band's backtested coverage falls between 60% and 76%.
8. Killing any single provider leaves the rest of the dashboard working and shows that provider's widget as stale/fallback.
9. No API key appears in client bundles or network responses.
10. The disclaimer is visible on every view.
