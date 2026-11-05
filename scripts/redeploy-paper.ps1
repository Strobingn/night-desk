# Restart the Node desk only. cloudflared is not stopped, so the phone hostname stays put.
# After Node is back, ensure-tunnel republishes the existing URL and starts a tunnel only if the old one is dead.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
function Read-DotEnvPort([string]$File) {
  if (-not (Test-Path $File)) { return $null }
  foreach ($line in Get-Content -LiteralPath $File) {
    if ($line -match '^\s*PORT\s*=\s*["'']?(\d+)') { return [int]$Matches[1] }
  }
  return $null
}
$FromFile = Read-DotEnvPort (Join-Path $Root ".env")
$Port = if ($env:DESK_PORT) { [int]$env:DESK_PORT } elseif ($env:PORT) { [int]$env:PORT } elseif ($FromFile) { $FromFile } else { 4721 }

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
  $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  if ($proc.ProcessName -match "cloudflared") {
    Write-Host "refusing to stop cloudflared pid $($proc.Id)"
    continue
  }
  if ($proc.ProcessName -ne "node") {
    Write-Host "port $Port is held by $($proc.ProcessName) pid $($proc.Id). Not stopping it."
    continue
  }
  Write-Host "stopping node pid $($proc.Id) on port $Port"
  Stop-Process -Id $proc.Id -Force
}

Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "paper:live") -WorkingDirectory $Root -WindowStyle Hidden
Write-Host "started npm run paper:live"
& (Join-Path $PSScriptRoot "ensure-tunnel.ps1")
