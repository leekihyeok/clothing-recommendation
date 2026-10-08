# Starts api, client and model as three separate hidden processes, logging to data/logs/dev-*.log.
# For unattended runs (e.g. from an agent): with `npm run dev` all three share one console, and the Nest CLI's
# restart (taskkill) there can take the other two down. Stop them with scripts/dev-bg-stop.ps1.
$root = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot\use-node.ps1" | Out-Null
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$npm = (Get-Command npm.cmd).Source

Push-Location $root
npm run build:shared | Out-Null
Pop-Location

$procs = @(
  @{ Name = 'api'; File = $npm; Args = @('run', 'dev', '-w', '@cr/api'); Dir = $root },
  @{ Name = 'client'; File = $npm; Args = @('run', 'dev', '-w', '@cr/client'); Dir = $root },
  @{ Name = 'model'; File = "$root\services\model\.venv\Scripts\python.exe"; Args = @('-m', 'uvicorn', 'app.main:app', '--reload', '--reload-dir', 'app', '--reload-dir', 'ai', '--port', '8100'); Dir = "$root\services\model" }
)
$ids = @()
foreach ($p in $procs) {
  $proc = Start-Process -FilePath $p.File -ArgumentList $p.Args -WorkingDirectory $p.Dir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$logs\dev-$($p.Name).log" -RedirectStandardError "$logs\dev-$($p.Name).err"
  $ids += $proc.Id
  "$($p.Name): pid $($proc.Id)"
}
$ids -join ',' | Out-File -Encoding ascii "$logs\dev-bg.pids"
