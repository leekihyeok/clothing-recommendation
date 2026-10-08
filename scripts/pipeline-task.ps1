# Registers (or with -Remove, removes) the "ROUTE01 pipeline" scheduled task: at this user's logon, run
# scripts/pipeline-bg.ps1 so the data keeper comes back after a reboot. Current user only, no admin rights needed.
param([switch]$Remove)
$name = 'ROUTE01 pipeline'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  "removed: $name"
  return
}
$script = Join-Path $PSScriptRoot 'pipeline-bg.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$user = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT1M'  # let the desktop (and Docker Desktop's own autostart) settle first
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'ROUTE 01: keeps the shop data fresh (python -m pipeline.refresh). See PROGRESS.md.' -Force | Out-Null
"registered: $name (at logon of $user)"
