# Gold Signal: Android app

A standalone Android app. The full dashboard (live price, factor monitor, chart with S/R overlays, projected ranges, signal board, news, calendar and the Performance page) runs **on the phone** with live data. It doesn't need your PC or the Windows server.

## How it works

The app contains the same data providers and analytics engine as the server (`server/src`). They run inside the app, and the phone fetches the free sources directly using Android's native HTTP client. Browser CORS rules don't apply to native HTTP, so every source the server uses is reachable. The UI is the same React dashboard, laid out for a phone screen.

The app keeps the same rules as the server:
- **$0 to run:** only free sources are used, and the same daily caps apply per provider.
- **Real data only:** nothing is estimated. Computed values carry a *Computed* badge and forecasts carry an *Estimate* badge.

## Install on your phone

1. Get the APK in one of two ways:
   - **From GitHub:** open the repository's **Actions** tab, choose the latest green **Android APK** run, and download the `gold-signal-apk-<n>` artifact. It's a zip; unzip it to get `gold-signal-<n>.apk`.
   - **Build it yourself:** see below.
2. Copy the APK to the phone, or download it on the phone, and open it.
3. Android asks you to allow installs from that app (for example Files or Chrome). Allow it, then tap **Install**. This is Android's standard prompt for apps that don't come from the Play Store.
4. Open **Gold Signal**. The spot price appears within about 15 seconds, and the signals, chart and ranges within about 30–60 seconds.

**Updating:** install a newer APK over the old one. Every build is signed with the same key and CI increases the version number on each run, so Android updates in place and keeps your settings and signal history.

## Optional free keys

Tap **Settings** in the header. The app works fully without keys, and each optional key is a free sign-up with no card:

| Key | Adds |
|---|---|
| Twelve Data | Spot XAU/USD candles. Without it, the chart uses COMEX gold futures (GC=F), clearly labeled |
| FRED | Seasonally adjusted CPI and official data-release dates |
| Finnhub | Extra market headlines |

Keys are stored only on the phone. Saving restarts the data engine.

## Things to know

- **Live while open.** Data updates while the app is on screen. Android pauses background work to save battery, so when you switch back to the app, every panel refreshes immediately.
- **Data use.** A cold start downloads about 8–10 MB of history: 25 years of daily bars, 2 years of hourly bars, and the Treasury, GPR and GLD files. After that, updates are small (a few KB every 15 seconds to 5 minutes, depending on the panel). On a metered connection, prefer Wi-Fi for the first launch of the day.
- **Performance page.** Backtests are CPU-heavy, so they run only when you open that page. The first time takes a few seconds on a phone.
- **Storage.** The signal and range logs, usage counters and settings are kept on the phone. Market history is re-downloaded on each app start instead of being stored.
- **Not financial advice.** For information and education only.

## Build it yourself

Requirements: Node ≥ 22.13, JDK 21, and the Android SDK (platform 36 and build-tools 36; installing Android Studio provides all of them).

```bash
npm ci
npm run android:apk        # web bundle → Capacitor sync → Gradle assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

On Windows, run `npm run android:sync`, then `cd android` and `gradlew.bat assembleRelease`. Or open the `android/` folder in Android Studio and use **Build ▸ Build APK(s)**.

`android/app/gold-signal-sideload.keystore` is a fixed signing key committed on purpose, so that every build (yours or CI's) can update the installed app. It is for personal sideloading only. To publish on the Play Store you would create your own private key.

## Project layout

| Path | What it is |
|---|---|
| `mobile/src/engine.ts` | Starts the in-app engine: native HTTP transport, on-device storage, same routes as the server API |
| `mobile/src/Settings.tsx` | The optional-keys screen |
| `mobile/src/main.tsx` | App entry: connects the web UI to the in-app engine |
| `capacitor.config.ts`, `android/` | Capacitor 8 Android project (app id `app.goldsignal.dashboard`) |
| `.github/workflows/android.yml` | CI: tests, typecheck and integrity check, then builds and uploads the signed APK |
