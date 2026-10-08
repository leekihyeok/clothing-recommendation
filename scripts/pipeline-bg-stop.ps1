# Stops the data keeper started by scripts/pipeline-bg.ps1 (and a leftover pipeline.quality_run, if any).
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -like '*pipeline.refresh*' -or $_.CommandLine -like '*pipeline.quality_run*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped $($_.ProcessId)" }
