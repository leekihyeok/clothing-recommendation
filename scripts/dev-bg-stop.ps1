# Stops the processes started by scripts/dev-bg.ps1 (and their children).
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'data\logs\dev-bg.pids'
if (-not (Test-Path $pidFile)) { 'nothing to stop'; return }
foreach ($id in (Get-Content $pidFile).Split(',')) {
  if ($id) { taskkill /PID $id /T /F 2>$null | Out-Null; "stopped $id" }
}
Remove-Item $pidFile
