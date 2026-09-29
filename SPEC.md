# Gold Signal Dashboard: Product & Technical Specification

**Version:** 1.1 (draft)
**Date:** 2026-09-29
**Status:** Proposed

**Changes in 1.1:** Two hard constraints were added: **zero cost** and **real data only** (see §1.3 and §1.4). Paid options were removed: Finnhub economic calendar, the paid LLM news classifier, and managed Redis/Postgres. Central-bank purchases were dropped from v1 because no free machine-readable source was confirmed. A free-tier request budget was added (§4.5).

---

## 1. Overview

A single-page web dashboard for XAU/USD (spot gold). It pulls **live, real market data from public APIs**, tracks the macro and market factors that drive gold, shows a news feed of events that could move it, and turns all of that into:

1. A **central interactive gold chart** with optional support/resistance overlays.
2. **Projected price ranges** (expected low/high) for the **day, week and month**.
3. A **Buy/Sell Signal Board** driven by a transparent, weighted scoring model.

> **Disclaimer (shown in the UI):** The dashboard is for information and education only and is not financial advice. Signals are probabilistic and can be wrong.

### 1.1 Goals
- Show real data only (§1.4). Every number shows its source and a "last updated" timestamp.
- Cost nothing to run (§1.3).
- Explain every signal: the user can see which factors pushed the score up or down.
- Measure predictions: range forecasts and signals are logged and backtested, and the hit rates are shown in the app.

### 1.2 Non-goals (v1)
- Order execution or broker integration.
- User accounts or portfolios (optional in v2).
- Assets other than gold. Silver, oil and others appear only as factor inputs.

### 1.3 Hard constraint: zero cost
- **Only $0 data sources.** A source is allowed if it needs no key, or if it has a free key with no credit card on file. Paid tiers, trials that expire into billing, and "free with card required" data plans are not allowed. The one card exception is Oracle's hosting sign-up, which is optional (§7.2); self-hosting needs no card.
- **Stay inside free limits by design.** The backend polls each provider once, caches the result and fans it out to all clients, so API usage doesn't grow with the number of users. §4.5 gives the request budget for each provider.
- **No paid AI/LLM APIs.** News classification uses rules, GDELT's own tone score and, optionally, an open-source model (FinBERT) running on our own server.
- **Free hosting only** (§7.2): a single always-on Node process with SQLite, run on a free VM or the user's own machine. No managed Redis/Postgres.
- **Open-source libraries only** (MIT/Apache/BSD), e.g. TradingView Lightweight Charts (Apache-2.0).
- A CI check fails the build if any provider config points to a paid endpoint or plan.

### 1.4 Hard constraint: real data only, nothing synthetic or fabricated
The app must never display a number that did not come from a real source or a documented calculation on real source data.

**Never allowed (anywhere in the production build):**
- Mock, demo, placeholder, random or "sample" data.
- Filling gaps by interpolation, forward-filling or smoothing. A missing candle is shown as a gap, and a missing factor value is shown as "—" with the reason.
- Synthetic candles (e.g., bars invented for weekends or outages).
- Estimated values presented as reported values. Examples: guessing today's value of a daily FRED series, or inventing a consensus forecast for a calendar event.
- Manually typed market data.
- Mixing instruments without saying so. COMEX gold futures (`GC=F`) are never shown as spot XAU/USD. Wherever futures data is used, it is labeled "COMEX futures."

**Allowed, with labels:**
- **Aggregated data:** e.g., 1H candles built from real 1m candles, or the forming candle built from real live ticks. Labeled with its source.
- **Computed analytics:** indicators, S/R zones, pivots, correlations, range projections, scores and news sentiment. These are shown with a **"Computed"** badge, their inputs are listed in a tooltip, and forecasts are always labeled **"Estimate."**
- **Last known real value when a source fails:** shown with its original timestamp and a 🔴 stale badge. It is never silently presented as current.

**Engineering rules:**
- Every stored data point keeps `source`, `fetched_at`, and the provider's own timestamp (provenance).
- Tests may use **recorded fixtures of real API responses**. Fixtures live only under `test/` and a build check ensures they are never bundled into the production app.
- Backtests use only real historical data with no look-ahead: each calculation for day *t* uses only data published before *t*. This includes FRED release dates, because macro data is often revised after its first release.

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
│ HEADER: XAU/USD 2,xxx.xx ▲+12.40 (+0.5%) │ Day H/L │ Session │ Data status │
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

## 4. Data Sources (real, public, $0)

All third-party calls go through **our backend**, which keeps API keys server-side, caches responses and stays inside free limits. The browser never calls a keyed API directly.

**Cost column key:** **Free, no key** = open endpoint. **Free key** = free sign-up with no card, used within its free quota. **Unofficial** = a free public endpoint with no official API contract; it can change or break, so it sits behind a replaceable adapter and only for display in a personal, non-commercial app, per the site's terms.

### 4.1 Gold price

| Purpose | Primary | Fallback | Cost | Notes |
|---|---|---|---|---|
| Live spot quote | **gold-api.com** `GET https://api.gold-api.com/price/XAU` | Close of the latest Twelve Data 1m bar (already fetched, so no extra calls). Shown with a "delayed" badge | Free, no key | Backend polls every 15 s and pushes to clients over SSE. Bid/ask is shown only if the source provides it, never estimated |
| Intraday OHLC (1m) | **Twelve Data** `time_series?symbol=XAU/USD&interval=1min` | Yahoo chart endpoint `GC=F`, **labeled as COMEX futures, not spot** | Free key | 5m/15m/1H/4H candles are aggregated from stored real 1m bars (§1.4) |
| Intraday history backfill | Twelve Data `interval=1h` / `4h` (a few calls/day) | n/a | Free key | Fills the history needed before we had stored 1m bars |
| Daily/weekly history (10+ yrs) | **Stooq CSV** `https://stooq.com/q/d/l/?s=xauusd&i=d` | Twelve Data `1day` | Free, no key | Backtests, pivots, volatility, seasonality |
| Volume (volume profile, VWAP) | Yahoo `GC=F` volume | n/a | Unofficial | Spot gold has no central volume. Labeled "COMEX futures volume." If unavailable, the VWAP and volume-profile features are hidden rather than estimated |

**Forming candle:** between Twelve Data pulls, the current 1m candle is built from real gold-api.com ticks and marked "forming." When the provider's official bar arrives, it replaces the forming one, because 15-second tick sampling can miss the true high and low.

### 4.2 Macro & cross-asset factors

| Factor | Source | Series / Endpoint | Cost | Refresh |
|---|---|---|---|---|
| 10Y real yield (TIPS) | **FRED API** | `DFII10` | Free key | Daily |
| 10Y nominal yield | FRED | `DGS10` (+ Yahoo `^TNX` for intraday, optional) | Free key / Unofficial | Daily / 5 min |
| 2Y yield (Fed expectations proxy) | FRED | `DGS2` | Free key | Daily |
| 10Y breakeven inflation | FRED | `T10YIE` | Free key | Daily |
| US Dollar | Yahoo `DX-Y.NYB` (DXY, intraday) | FRED `DTWEXBGS` (broad dollar index, daily). The two are different indexes, and the UI names whichever one is shown | Unofficial / Free key | 5 min / daily |
| Gold implied volatility | FRED | `GVZCLS` (CBOE Gold ETF Volatility Index) | Free key | Daily |
| Equity risk sentiment | FRED `VIXCLS`; Yahoo `^VIX`, `^GSPC` | | Free key / Unofficial | Daily / 5 min |
| Fed funds rate | FRED | `DFEDTARU`, `DFEDTARL` | Free key | On change |
| CPI / Core CPI | FRED | `CPIAUCSL`, `CPILFESL` | Free key | Monthly |
| Crude oil | FRED `DCOILWTICO`; Yahoo `CL=F` | | Free key / Unofficial | Daily / 5 min |
| Silver (gold/silver ratio) | gold-api.com `/price/XAG` | | Free, no key | 60 s |
| Copper (copper/gold ratio) | Yahoo `HG=F` | | Unofficial | 5 min |
| Bitcoin (competing "hard asset") | Coinbase Exchange public ticker `GET https://api.exchange.coinbase.com/products/BTC-USD/ticker` | | Free, no key | 60 s |
| CFTC positioning (managed money) | **CFTC Public Reporting Environment** (Socrata API), Disaggregated Futures-Only report, market code `088691` (Gold, COMEX) | | Free, no key | Weekly (Fri) |
| Gold ETF holdings | SPDR Gold Shares (GLD) historical holdings file (tonnes), published on spdrgoldshares.com | | Free, no key | Daily |
| Geopolitical risk | Caldara–Iacoviello **GPR Index** (daily data file, matteoiacoviello.com) + GDELT tone (below) | | Free, no key | Daily |
| Seasonality | Computed from Stooq history | | $0 | Recomputed monthly |

Daily series (FRED, GVZ, GLD, GPR) are shown with their **observation date**, e.g. "DFII10 1.92% · as of Sep 26." They are never presented as intraday values.

**Removed in 1.1:** central-bank gold purchases. The World Gold Council publishes these only in reports, and typing them in by hand would break §1.4. The factor can return in v2 if a free machine-readable official source (e.g. IMF reserve statistics) is confirmed.

### 4.3 News & events

| Purpose | Source | Cost | Notes |
|---|---|---|---|
| Global news stream | **GDELT DOC 2.0 API**, query e.g. `gold OR "Federal Reserve" OR inflation OR "central bank" OR sanctions OR war OR tariff` | Free, no key | Returns articles plus a tone score. Refresh every 5 min |
| Market headlines | **Finnhub** `/news?category=general` and `forex` | Free key | Refresh every 2 min. Only free-tier endpoints are used |
| Official statements | RSS feeds: Federal Reserve press releases (`federalreserve.gov/feeds/press_all.xml`), ECB press releases | Free, no key | Refresh every 5 min |
| Economic calendar: event, time, impact, forecast, previous | Forex Factory weekly JSON (`nfs.faireconomy.media/ff_calendar_thisweek.json`) | Unofficial | Refresh every 30 min |
| Calendar fallback: dates only | **FRED `fred/releases/dates`** (scheduled release dates, including future ones, for CPI, jobs report, GDP, PCE, …) + the Federal Reserve's published FOMC meeting calendar | Free key / Free | Official sources have no consensus forecasts. When the fallback is in use, the Forecast column shows "—"; forecasts are never invented |
| Actual released values | FRED (after release) or the Forex Factory "actual" field | Free key / Unofficial | |

### 4.4 Data-quality rules
- Every widget shows a **source label** and a **freshness badge**: 🟢 live (< 2× expected interval), 🟡 delayed, 🔴 stale/failed.
- If the primary source fails, switch to the fallback automatically and note it in the header's data status. If every source fails, show the last real value with its original timestamp and a 🔴 badge (§1.4). Never estimate.
- **Sanity checks:** reject a tick that moves more than 3% from the last good price within 1 minute unless the next Twelve Data bar confirms it.
- Mark weekend/market-closed periods (gold trades roughly Sun 18:00 to Fri 17:00 ET, with a daily 17:00–18:00 ET break). No candles are drawn while the market is closed. Pollers slow down or pause during closures to save quota.
- Respect each provider's terms of service. Unofficial endpoints (Yahoo, Forex Factory) must be replaceable behind a provider interface, and the app must keep working without them (their widgets show "unavailable").

### 4.5 Free-tier request budget
Free-quota numbers change. Check each provider's current limits before launch, and have the scheduler enforce a per-provider daily cap set **below** the free limit.

| Provider | Our usage (market day) | Free-tier guardrail |
|---|---|---|
| gold-api.com | XAU every 15 s + XAG every 60 s ≈ 7,200 calls/day | No key. If rate-limited (HTTP 429), back off to 60 s |
| Twelve Data | 1m bars every 3 min (480) + backfill/daily (~20) ≈ **500 credits/day** | Free plan ≈ 800 credits/day and 8/min. Hard cap at 700/day |
| FRED | ~15 series × a few polls/day ≈ 60 calls/day | Far below the free limit (~120 requests/min) |
| Finnhub | 2 categories every 2 min ≈ 1,440 calls/day | Free plan ≈ 60 calls/min |
| GDELT | 1 query every 5 min ≈ 288 calls/day | No key. Keep ≥ 5 s between calls |
| Yahoo (unofficial) | ~6 symbols every 5 min, batched ≈ 300 calls/day | Back off on any 429/403 and mark "unavailable" |
| CFTC, GLD, GPR, Stooq, Fed/ECB RSS, Forex Factory | ≤ 50 calls/day in total | n/a |

Because the backend fans data out to all clients, these numbers stay the same whether one person or many are using the dashboard.

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
| **VWAP** | Session VWAP (intraday frames only), computed from COMEX futures volume and labeled as such. Hidden if futures volume is unavailable |
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
- **Classification ($0):** v1 uses a keyword/rules engine plus the GDELT tone score. v2 can add **FinBERT** (open-source financial sentiment model, e.g. `ProsusAI/finbert`) running on our own server via ONNX/transformers, on headline and snippet only, with results cached per article. No paid LLM APIs. The tags are computed labels and are shown with the "Computed" badge. The headline, source, time and link are always shown exactly as published.
- Filters by topic and impact, plus a "High impact only" toggle.
- A **news sentiment index**: the 24-hour rolling average of impact × direction, fed into the scoring model.
- High-impact items appear as markers on the chart (5.2).

### 5.7 Economic Calendar
- The next 7 days of events that matter for USD and gold: FOMC, CPI, PCE, NFP, GDP, ISM, jobless claims, Fed speakers, and ECB/BoJ/PBoC decisions.
- Shows time (in the user's timezone), impact (low/med/high), forecast, previous, and actual once released. Any field the source doesn't provide shows "—" (e.g., the forecast when running on the official-dates fallback, §4.3).
- A countdown to the next high-impact event.
- Once an event is released, the surprise (actual − forecast) is tagged bullish or bearish for gold using a rules table (for example, CPI above forecast means hawkish, which is bearish in the short term). If no real forecast is available, no surprise tag is shown.

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
            │ Backend: one always-on Node process (Fastify)               │
            │  • Provider adapters (price, macro, news, calendar)         │
            │  • Scheduler/pollers (cron + interval jobs)                 │
            │  • Engines: indicators, S/R, ranges, scoring, news classify │
            │  • Cache: in-memory LRU · Storage: SQLite (history, logs)   │
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
- **Deployment:** see §7.2. There are no managed databases or paid services.

### 7.1 Internal API (backend → frontend)

| Endpoint | Returns |
|---|---|
| `GET /api/quote` | `{price, bid?, ask?, change, changePct, high, low, source, ts, status}` (bid/ask only when the source provides them) |
| `GET /api/stream` | SSE stream of quote ticks and signal updates |
| `GET /api/candles?tf=1h&limit=500` | OHLCV array |
| `GET /api/levels?tf=1h` | `{support:[{price, low, high, strength}], resistance:[…], pivots:{…}, fib:{…}}` |
| `GET /api/ranges` | `{day:{low, high, extLow, extHigh, method, hitRate}, week:{…}, month:{…}}` |
| `GET /api/factors` | array of `{id, name, value, change1d, change1w, spark[], impact, corr30d, source, ts, status}` |
| `GET /api/signals` | `{intraday:{score, label, confidence, drivers[], eventRisk, levels}, swing:{…}, position:{…}, ts}` |
| `GET /api/news?topic=&minImpact=` | array of `{id, title, url, source, ts, snippet, topic, direction, impact, rationale}` |
| `GET /api/calendar?days=7` | array of `{ts, country, event, impact, forecast, previous, actual, goldBias}` |
| `GET /api/performance` | backtest and forward-tracking stats |

Every value in every response carries `source` and `ts`. Computed values also carry `computed: true` and an `inputs` list, so the UI can badge them (§1.4).

### 7.2 Free hosting ($0)
The backend has to run continuously (pollers plus SSE), and serverless free tiers generally don't allow that. The supported options are:

| Option | Cost | Notes |
|---|---|---|
| **Self-host (recommended)**: `docker compose up` on your own PC, home server or Raspberry Pi | $0 | Full control and no platform limits. Optional free public access via Cloudflare Tunnel |
| Oracle Cloud "Always Free" VM | $0 | Always on. Sign-up asks for card verification, but the Always Free resources are not billed |
| Render / Koyeb free web service | $0 | Works for demos only: free instances sleep when idle, which pauses the pollers. The UI shows data as stale after wake-up until the first poll finishes |

- Frontend: served as static files by the same Node process, or from Cloudflare Pages / GitHub Pages (free) pointing at the backend.
- Storage: one SQLite file (WAL mode). A few years of 1m bars plus factor history is well under 1 GB.
- Scheduling: in-process scheduler (e.g. `node-cron`), not paid platform cron.

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
- User alerts via free channels (Telegram Bot API, browser Web Push, Discord webhook) on signal label changes, price crossing S/R, or high-impact news.
- An ML forecaster (open-source gradient boosting such as LightGBM, trained locally on real history) for next-day direction probability, shown next to the rules score and only after it beats the rules model out of sample.
- Multi-currency gold (XAU in EUR, INR, CNY, AED) from free FX sources, e.g. the ECB reference rates. The Shanghai Gold Exchange premium is included only if a free, real data source is confirmed.
- Central-bank gold purchases, if a free machine-readable official source is confirmed (§4.2).
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
1. The header price matches an independent public reference (e.g., the Twelve Data latest 1m close) within $1 during market hours and updates at least every 30 s.
2. The chart shows real XAU/USD candles for all 7 timeframes, and the live candle updates in place.
3. Each overlay (S/R, pivots, Fib, MAs, Bollinger, range bands) can be toggled on and off independently, and the setting survives a page reload.
4. The Factor Monitor shows at least 10 live factors, each with source, timestamp, impact tag and 30-day correlation.
5. The news feed shows items less than 15 minutes old during active news hours, each tagged with topic and impact.
6. The Signal Board shows three horizons, each with score, label, confidence, top drivers and an event-risk warning when applicable. The "Why?" drawer's contributions add up to the displayed score.
7. Projected day/week/month ranges are shown with their method and a historical hit rate. The 68% band's backtested coverage falls between 60% and 76%.
8. Killing any single provider leaves the rest of the dashboard working and shows that provider's widget as stale/fallback.
9. No API key appears in client bundles or network responses.
10. The disclaimer is visible on every view.
11. **Zero cost:** the full app runs for 30 days with $0 spent. No provider config points at a paid plan, no data-provider account has a card attached (§1.3), and each provider's daily usage logs stay under its cap in §4.5.
12. **No synthetic data:** a code search of the production build finds no mock, random or sample data generators. Simulating a provider outage produces "—" or a stale-badged last real value, never an estimate or interpolation. Every displayed value can be traced through its `source` and `ts` to a real fetch or a documented calculation.
