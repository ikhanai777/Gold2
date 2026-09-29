# Verifies a running dashboard end to end. Exit code 0 = healthy, 1 = failed.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\healthcheck.ps1 [-BaseUrl http://127.0.0.1:8787] [-TimeoutSec 240]
param([string]$BaseUrl = 'http://127.0.0.1:8787', [int]$TimeoutSec = 240)
$ErrorActionPreference = 'Continue'
$Deadline = (Get-Date).AddSeconds($TimeoutSec)
$Results = New-Object System.Collections.Generic.List[object]
function Add-Result($Check, $State, $Detail) { $Results.Add([pscustomobject]@{ Check = $Check; Result = $State; Detail = $Detail }) }
function Get-Api($Path) { Invoke-RestMethod -Uri "$BaseUrl/api/$Path" -TimeoutSec 15 }

# 1. Server answers.
$status = $null
while (-not $status -and (Get-Date) -lt $Deadline) {
    try { $status = Get-Api 'status' } catch { Start-Sleep -Seconds 3 }
}
if (-not $status) {
    Write-Output "FAIL: no response from $BaseUrl within $TimeoutSec s. See logs\server.log."
    exit 1
}
Add-Result 'API reachable' 'PASS' $BaseUrl

# 2. Wait for the first data load (candles + analytics take about 30-90 s after start).
$signals = $null
while ((Get-Date) -lt $Deadline) {
    try { $signals = Get-Api 'signals' } catch { }
    if ($signals -and $signals.cards.Count -ge 3) { break }
    Start-Sleep -Seconds 5
}

try {
    $page = Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 15
    if ($page.StatusCode -eq 200 -and $page.Content -match 'id="root"') { Add-Result 'Web page' 'PASS' 'index.html served' }
    else { Add-Result 'Web page' 'FAIL' "HTTP $($page.StatusCode)" }
} catch { Add-Result 'Web page' 'FAIL' $_.Exception.Message }

try {
    $q = Get-Api 'quote'
    if ($q.spot -and $q.spot.price -gt 0) { Add-Result 'Spot price' 'PASS' ("{0} from {1}" -f $q.spot.price, $q.spot.source) }
    else { Add-Result 'Spot price' 'FAIL' 'no spot price yet' }
} catch { Add-Result 'Spot price' 'FAIL' $_.Exception.Message }

$status = Get-Api 'status'
if ($status.analysisInstrument) { Add-Result 'Chart candles' 'PASS' "analysis instrument $($status.analysisInstrument)" }
else { Add-Result 'Chart candles' 'FAIL' 'no candle history loaded' }

if ($signals -and $signals.cards.Count -ge 3) {
    Add-Result 'Signal board' 'PASS' (($signals.cards | ForEach-Object { "$($_.horizon)=$($_.label)" }) -join ', ')
} else { Add-Result 'Signal board' 'FAIL' 'fewer than 3 horizons scored' }

try {
    $r = Get-Api 'ranges'
    if ($r.bands.Count -eq 3) { Add-Result 'Projected ranges' 'PASS' 'day, week, month' } else { Add-Result 'Projected ranges' 'FAIL' "$($r.bands.Count) bands" }
} catch { Add-Result 'Projected ranges' 'FAIL' $_.Exception.Message }

try {
    $f = (Get-Api 'factors').factors
    $withValue = @($f | Where-Object { $_.value -ne $null }).Count
    if ($withValue -ge 10) { Add-Result 'Factors' 'PASS' "$withValue of $($f.Count) have values" }
    else { Add-Result 'Factors' 'WARN' "only $withValue of $($f.Count) have values (some sources load later)" }
} catch { Add-Result 'Factors' 'FAIL' $_.Exception.Message }

try {
    $n = Get-Api 'news'
    if ($n.items.Count -gt 0) { Add-Result 'News feed' 'PASS' "$($n.items.Count) items" } else { Add-Result 'News feed' 'WARN' 'no items yet (feeds poll every 5 min)' }
} catch { Add-Result 'News feed' 'WARN' $_.Exception.Message }

try {
    $c = Get-Api 'calendar?days=7'
    if ($c.events.Count -gt 0) { Add-Result 'Calendar' 'PASS' "$($c.events.Count) events" } else { Add-Result 'Calendar' 'WARN' 'no events loaded' }
} catch { Add-Result 'Calendar' 'WARN' $_.Exception.Message }

$failingProviders = @($status.providers | Where-Object { $_.lastError -and (-not $_.lastOk -or $_.lastErrorAt -gt $_.lastOk) } | ForEach-Object { "$($_.provider): $($_.lastError)" })
if ($failingProviders.Count) { Add-Result 'Data sources' 'WARN' ($failingProviders -join '; ') } else { Add-Result 'Data sources' 'PASS' 'no provider errors' }

$Results | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Output
if (@($Results | Where-Object { $_.Result -eq 'FAIL' }).Count) { Write-Output 'HEALTHCHECK: FAIL'; exit 1 }
Write-Output 'HEALTHCHECK: PASS'
exit 0
