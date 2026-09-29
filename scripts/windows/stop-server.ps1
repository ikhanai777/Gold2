# Stops the dashboard server: the scheduled task (if any), the restart loop and node itself.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\stop-server.ps1 [-Uninstall]
param([string]$TaskName = 'GoldSignalDashboard', [switch]$Uninstall)
$ErrorActionPreference = 'Continue'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName
    if ($Uninstall) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Scheduled task '$TaskName' removed."
    }
}

# Stop the restart loop first so it cannot relaunch node.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*start-server.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output "Stopped launcher (PID $($_.ProcessId))" }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server\src\index.ts*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Output "Stopped server (PID $($_.ProcessId))" }
