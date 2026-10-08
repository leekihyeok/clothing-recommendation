# Switches the CURRENT terminal to the Node version in .nvmrc, without touching the
# machine-wide `nvm use` setting, so other projects keep their own Node version.
#
#   . .\scripts\use-node.ps1      (note the leading dot: it must be dot-sourced)

$major = (Get-Content (Join-Path $PSScriptRoot '..\.nvmrc')).Trim()
$nvmRoot = if ($env:NVM_HOME) { $env:NVM_HOME } else { Join-Path $env:USERPROFILE 'nvm' }

$dir = Get-ChildItem $nvmRoot -Directory -Filter "v$major.*" -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Name.TrimStart('v') } -Descending |
  Select-Object -First 1

if (-not $dir) {
  Write-Error "Node $major is not installed. Run: nvm install $major   (then switch back with nvm use <your usual version>)"
  return
}

$env:Path = "$($dir.FullName);" + (($env:Path -split ';' | Where-Object { $_ -and $_ -ne $dir.FullName }) -join ';')
Write-Host "This terminal now uses Node $(node -v) from $($dir.FullName)"
