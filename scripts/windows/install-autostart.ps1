# Registers a Windows scheduled task that starts the dashboard server at logon
# (hidden window, auto-restart), then starts it now.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
param([string]$TaskName = 'GoldSignalDashboard')
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Start = Join-Path $PSScriptRoot 'start-server.ps1'
$User = "$env:USERDOMAIN\$env:USERNAME"

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Start`"" `
    -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
    -Principal $Principal -Description 'Gold Signal Dashboard server (http://127.0.0.1:8787)' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Scheduled task '$TaskName' installed for $User and started."
