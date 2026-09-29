# Deploying Gold Signal Dashboard on Windows 10: Instructions for the Hermes Agent

These instructions are for an autonomous agent (Nous Hermes Agent) running on the user's Windows 10 PC. Follow the steps in order. Run each command, check its **Expect** line, and only continue when it matches. If a step fails, use the matching row in §9 Troubleshooting. If nothing there fixes it, stop and report to the user (§10).

## 0. Ground rules

- **Do not change application code** (`server/`, `web/`, `config/`). This is a deployment task. If something only a code change would fix, stop and report it.
- **Never add paid services, paid API keys or credit cards.** The app is designed to run at $0.
- **Never disable TLS/certificate checks** (no `NODE_TLS_REJECT_UNAUTHORIZED=0`, no `npm config set strict-ssl false`).
- **Keep it local.** The server listens on `127.0.0.1` only. Expose it to the LAN (§8) only if the user explicitly asks.
- **Ask the user before:** installing software, creating the startup task, opening firewall ports, and entering any API key. The key values must come from the user; never invent or reuse keys.
- **Do not print secrets.** Never echo the contents of `.env` in your report.

| Setting | Value |
|---|---|
| Repository | `https://github.com/ikhanai777/Gold2` |
| Branch | `ccr-00e8eb98-d03gy3` (use `main` instead if the user says it has been merged) |
| Install folder | `%USERPROFILE%\Gold2` (for example `C:\Users\<name>\Gold2`) |
| URL when running | `http://127.0.0.1:8787` |
| Scheduled task name | `GoldSignalDashboard` |
| Log file | `%USERPROFILE%\Gold2\logs\server.log` |

## 1. Check which shell you have

Run:

```
echo %OS% & ver
```

- **Expect:** `Windows_NT` and a version starting `Microsoft Windows [Version 10.`. You have a native Windows shell. Use **Path A** (§2–§7) and run commands in **PowerShell**. If your terminal is `cmd.exe`, prefix each PowerShell command with `powershell -NoProfile -Command "..."`, or start `powershell` first.
- **If instead** you get `%OS%` printed literally, or a Linux-style error, you are inside **WSL/bash**. Use **Path B** (§11).

## 2. Prerequisites (Path A: native Windows)

Run in PowerShell:

```powershell
node -v; npm -v; git --version; winget --version
```

**Expect:**
- **Node:** `v22.13.0` or newer (Node 22 LTS or 24 LTS). The app uses the built-in `node:sqlite`, which needs Node ≥ 22.13.
- **Git:** any version.

If Node or Git is missing or too old, **ask the user for permission**, then install:

```powershell
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
```

After installing, **open a new PowerShell window** so `PATH` refreshes, then re-run the version check. If `winget` is missing, ask the user to install "App Installer" from the Microsoft Store, or to install Node LTS from https://nodejs.org and Git from https://git-scm.com.

## 3. Get the code

```powershell
cd $env:USERPROFILE
git clone --branch ccr-00e8eb98-d03gy3 https://github.com/ikhanai777/Gold2.git Gold2
cd $env:USERPROFILE\Gold2
git log --oneline -1
```

**Expect:** the clone completes and the last command prints one commit line.

- **If the folder already exists:** do not delete it. Update it instead, with `cd $env:USERPROFILE\Gold2; git fetch origin; git checkout ccr-00e8eb98-d03gy3; git pull`.
- **If git asks for credentials or says "Repository not found":** the repository is private. Ask the user to complete the GitHub sign-in window that Git Credential Manager opens, or to give you a download of the branch as a ZIP. Never ask the user to paste a password into chat.

## 4. Optional free API keys

The app runs fully **without any keys**. Keys only add features:

| Key | Adds | Where to get it (free, no card) |
|---|---|---|
| `TWELVEDATA_API_KEY` | Spot XAU/USD candles. Without it, the chart uses COMEX gold futures (GC=F), clearly labeled | https://twelvedata.com/pricing (Basic plan) |
| `FRED_API_KEY` | Seasonally adjusted CPI, and official data-release dates as a calendar fallback | https://fred.stlouisfed.org/docs/api/api_key.html |
| `FINNHUB_API_KEY` | Extra market headlines | https://finnhub.io/register |

Create the settings file:

```powershell
cd $env:USERPROFILE\Gold2
Copy-Item .env.example .env
```

**Ask the user** whether they want to add any keys. If they give you values, put each one after the `=` on its line in `.env`, for example `TWELVEDATA_API_KEY=abc123`. Use `notepad .env`, or set the values with PowerShell string replacement. Leave unused keys empty. Keep `HOST=127.0.0.1` and `PORT=8787` unless the user asks otherwise.

## 5. Install, build and verify

```powershell
cd $env:USERPROFILE\Gold2
npm ci
npm run build
npm test
npm run check:integrity
```

**Expect:**
- **`npm ci`:** finishes without `ERR!`. `npm audit` warnings are fine.
- **`npm run build`:** prints `✓ built in …`, and `web\dist\index.html` exists.
- **`npm test`:** prints `# pass 14` and `# fail 0`.
- **`npm run check:integrity`:** prints `Integrity check passed`.

If any of these fail, see §9. Do not continue to §6 with a failing build or test.

## 6. First run in the foreground (smoke test)

Start the server in a **separate** PowerShell window, so it keeps running while you check it:

```powershell
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$env:USERPROFILE\Gold2\scripts\windows\start-server.ps1"
```

Then run the health check. It waits up to 4 minutes for the first data load:

```powershell
cd $env:USERPROFILE\Gold2
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\healthcheck.ps1
```

**Expect:** a table of checks ending in `HEALTHCHECK: PASS` (exit code 0).

- **Rows that must PASS:** API reachable, Web page, Spot price, Chart candles, Signal board and Projected ranges.
- **Rows that may show `WARN`:** Factors, News feed, Calendar and Data sources, especially in the first minutes. Some sources are known to fail from some networks; see "Expected warnings" in §9.

If you have a browser tool, open `http://127.0.0.1:8787` and confirm the dashboard shows a gold price, a candlestick chart, the Signal board and the news feed.

Then stop the smoke-test server:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\stop-server.ps1
```

**Expect:** `Stopped launcher (PID …)` and `Stopped server (PID …)`.

## 7. Run it permanently (start at logon, auto-restart)

**Ask the user** before creating the startup task. Then:

```powershell
cd $env:USERPROFILE\Gold2
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\healthcheck.ps1
```

**Expect:** `Scheduled task 'GoldSignalDashboard' installed … and started.`, then `HEALTHCHECK: PASS`.

What this sets up:
- **When it runs:** a hidden server starts every time this user logs in to Windows.
- **Crash recovery:** if the server crashes, the launcher restarts it after 10 seconds. The task itself retries 3 times.
- **Where the data lives:** logs go to `logs\server.log`, and stored history goes to `data\gold.db`.

If registration fails with `Access is denied`, ask the user to run that one command from **PowerShell (Run as administrator)**, or to approve elevation.

Useful commands:

```powershell
Get-ScheduledTask -TaskName GoldSignalDashboard | Select-Object TaskName, State      # Expect: Running
Get-Content $env:USERPROFILE\Gold2\logs\server.log -Tail 30                          # recent log
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\stop-server.ps1   # stop
Start-ScheduledTask -TaskName GoldSignalDashboard                                     # start again
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\stop-server.ps1 -Uninstall   # stop and remove autostart
```

### Updating to a newer version later

```powershell
cd $env:USERPROFILE\Gold2
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\stop-server.ps1
git pull
npm ci
npm run build
npm test
Start-ScheduledTask -TaskName GoldSignalDashboard
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\healthcheck.ps1
```

`.env` and `data\` are kept across updates; both are ignored by git.

## 8. Optional: open it to other devices on the home network

Only do this if the user asks.

1. In `.env`, set `HOST=0.0.0.0`.
2. Restart the server with `stop-server.ps1`, then `Start-ScheduledTask -TaskName GoldSignalDashboard`.
3. From an **administrator** PowerShell, allow the port on private networks only:
   ```powershell
   New-NetFirewallRule -DisplayName 'Gold Signal Dashboard' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
   ```
4. Tell the user the address to use: `http://<PC-IP>:8787`. Get the IP with `(Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp).IPAddress`.

Never use `-Profile Any` or `Public`, and never set up port forwarding on the router. The app has no login, so it must not be reachable from the internet.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `node` / `git` not recognized after install | PATH not refreshed | Open a new PowerShell window |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` or `No such built-in module: node:sqlite` | Node older than 22.13 | Install the current Node LTS (§2) |
| `npm ci` fails fetching `cdn.sheetjs.com/xlsx-0.20.3` | That host is blocked or down | Retry. On a company network, ask the user to allow `cdn.sheetjs.com` |
| `npm ci` fails with `EPERM`/`EBUSY` | Antivirus or editor locking `node_modules` | Close editors, stop the server (`stop-server.ps1`), run `npm ci` again |
| `running scripts is disabled on this system` | PowerShell execution policy | Always run the scripts as shown: `powershell -NoProfile -ExecutionPolicy Bypass -File …` |
| Health check: "no response from http://127.0.0.1:8787" | Server not running, or crashed | `Get-Content logs\server.log -Tail 50` and act on the error |
| `EADDRINUSE :::8787` / `127.0.0.1:8787` in the log | Port already used (often an old instance) | Run `stop-server.ps1`. If it persists: `Get-NetTCPConnection -LocalPort 8787 \| Select OwningProcess`, then tell the user which program owns it, or set `PORT=8788` in `.env` and use that port everywhere |
| `The frontend is not built` | `web\dist` missing | `npm run build` |
| `Dependencies are missing` | `node_modules` missing | `npm ci` |
| Chart says "Loading real candles…" for more than 3 minutes | Yahoo Finance blocked on this network | Check the log for `[yahoo]` errors. Adding a free `TWELVEDATA_API_KEY` gives an independent candle source |
| Behind a corporate proxy, every source fails | Outbound HTTPS needs a proxy | Set `HTTPS_PROXY=http://proxy:port` in `.env` (the app supports it). Never disable TLS |
| Scheduled task shows `Ready` instead of `Running` | Task stopped or failed to launch | `Start-ScheduledTask -TaskName GoldSignalDashboard`, then check `logs\server.log` |

**Expected warnings (not failures):**
- **`stooq: …` failures:** Stooq sometimes blocks automated requests. The only effect is that the header's spot "change vs previous close" shows `—`.
- **`gdelt: HTTP 429`:** GDELT rate-limits shared IPs. The news feed still works from the other RSS sources.
- **`bls: daily threshold …`:** the free BLS quota is shared per IP. CPI loads on a later retry, or immediately with a free `FRED_API_KEY`.
- **"Data sources: N failing":** the header button lists each provider's status. Occasional failures of unofficial sources (Yahoo, Swissquote, Forex Factory) only blank the widgets that depend on them.

## 10. Report back to the user

When done, send a short report with:

1. **Result:** deployed and running, or blocked at step N.
2. **URL:** `http://127.0.0.1:8787` (plus the LAN address if §8 was done).
3. **Versions:** Node version, and the git commit (`git log --oneline -1`).
4. **Keys:** which optional keys are set (names only, never values).
5. **Health check:** the result table from `healthcheck.ps1`, pasted as-is.
6. **Autostart:** whether it is installed (`Get-ScheduledTask … State`).
7. **Problems:** any `WARN` rows, and what they mean from §9.
8. **Disclaimer:** the dashboard is for information and education, not financial advice.

## 11. Path B: the agent runs inside WSL2 (bash)

Use this path only if §1 showed you are in Linux/WSL. The app runs inside WSL, and Windows 10 forwards `localhost` to WSL2, so the user opens it in their Windows browser.

1. **Prerequisites:**
   ```bash
   node -v || true; git --version
   ```
   If Node is missing or older than 22.13, ask the user, then install Node 22 LTS with nvm:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   . ~/.nvm/nvm.sh && nvm install 22
   ```
2. **Code, keys and build:** clone into the Linux home, not `/mnt/c`, which is slow for `node_modules`.
   ```bash
   cd ~ && git clone --branch ccr-00e8eb98-d03gy3 https://github.com/ikhanai777/Gold2.git Gold2 && cd Gold2
   cp .env.example .env    # ask the user about optional keys (§4)
   sed -i 's/^HOST=.*/HOST=0.0.0.0/' .env   # lets Windows reach the WSL server via localhost
   npm ci && npm run build && npm test && npm run check:integrity
   ```
3. **Run and verify:**
   ```bash
   mkdir -p logs && nohup npm start > logs/server.log 2>&1 &
   ```
   Then call the health check from Windows PowerShell:
   ```bash
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/Gold2/scripts/windows/healthcheck.ps1)"
   ```
   **Expect:** `HEALTHCHECK: PASS`. The user opens `http://localhost:8787` in the Windows browser.
4. **Autostart:** only with the user's permission. Create a Windows logon task that starts the server inside WSL:
   ```bash
   powershell.exe -NoProfile -Command "Register-ScheduledTask -TaskName GoldSignalDashboard -Trigger (New-ScheduledTaskTrigger -AtLogOn -User \"\$env:USERDOMAIN\\\$env:USERNAME\") -Action (New-ScheduledTaskAction -Execute 'wsl.exe' -Argument '-e bash -lc \"cd ~/Gold2 && mkdir -p logs && npm start >> logs/server.log 2>&1\"') -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)) -Force"
   ```
   Check it with `powershell.exe -NoProfile -Command "Get-ScheduledTask -TaskName GoldSignalDashboard"`.
5. **Stop:** `pkill -f "[t]sx server/src/index.ts"`.

Report back as in §10.
