# Runs the Gold Signal Dashboard server and restarts it if it ever exits.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start-server.ps1
# Logs: <repo>\logs\server.log
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$Tsx = Join-Path $Root 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $Tsx)) { throw "Dependencies are missing. Run 'npm ci' in $Root first." }
if (-not (Test-Path (Join-Path $Root 'web\dist\index.html'))) { throw "The frontend is not built. Run 'npm run build' in $Root first." }

$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'server.log'

# Hide Node's "SQLite is experimental" notice from the log.
$env:NODE_OPTIONS = '--disable-warning=ExperimentalWarning'

# Native stderr must not become a PowerShell error, so run node through cmd.exe.
$ErrorActionPreference = 'Continue'
while ($true) {
    if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 20MB)) {
        Move-Item -Force $Log (Join-Path $LogDir 'server.log.1')
    }
    Add-Content -Path $Log -Value ('{0} [launcher] starting server' -f (Get-Date -Format o))
    & cmd.exe /c "node `"$Tsx`" server\src\index.ts >> `"$Log`" 2>&1"
    Add-Content -Path $Log -Value ('{0} [launcher] server exited with code {1}; restarting in 10 s' -f (Get-Date -Format o), $LASTEXITCODE)
    Start-Sleep -Seconds 10
}
