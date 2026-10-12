# Starts the data keeper (python -m pipeline.refresh) as one hidden process, logging to data/logs/refresh.log.
# Run at Windows logon by the "ROUTE01 pipeline" scheduled task (scripts/pipeline-task.ps1), or by hand.
# Waits for Docker (starting Docker Desktop if needed) so the DB is up; does nothing if the keeper already runs.
# Stop it with scripts/pipeline-bg-stop.ps1, or create data/logs/STOP to stop after the current step.
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

$running = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*pipeline.refresh*' -or $_.CommandLine -like '*pipeline.quality_run*' }
if ($running) { "already running: pid $(@($running)[0].ProcessId)"; return }

# Docker engine: start Docker Desktop if it isn't answering, then wait up to 10 minutes.
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) { Start-Process $desktop }
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep 5
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
  }
}
docker compose -f (Join-Path $root 'infra\docker-compose.yml') up -d --wait *> (Join-Path $logs 'pipeline-bg-docker.log')
# Even if Docker never came up, start the keeper: it waits for the DB on its own.

Remove-Item (Join-Path $logs 'STOP') -ErrorAction SilentlyContinue
$log = Join-Path $logs 'refresh.log'
# Earlier runs' logs are kept (refresh-<when it was replaced>.log, the newest 20), not overwritten: when the keeper
# stopped, its last log is what says why.
if (Test-Path $log) {
  Move-Item $log (Join-Path $logs ("refresh-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))) -Force
  Get-ChildItem $logs -Filter 'refresh-*.log' | Sort-Object Name -Descending | Select-Object -Skip 20 | Remove-Item -Force
}
$err = Join-Path $logs 'refresh.err'
if ((Test-Path $err) -and (Get-Item $err).Length -gt 0) { Move-Item $err (Join-Path $logs ("refresh-{0:yyyyMMdd-HHmmss}.err" -f (Get-Date))) -Force }
$proc = Start-Process -FilePath (Join-Path $root 'services\model\.venv\Scripts\python.exe') `
  -ArgumentList '-u', '-m', 'pipeline.refresh' -WorkingDirectory (Join-Path $root 'services\model') -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError (Join-Path $logs 'refresh.err')
$proc.Id | Out-File -Encoding ascii (Join-Path $logs 'refresh.pid')
"refresh: pid $($proc.Id)"
