# Keep the phone URL stable. Starts cloudflared only when no tunnel already targets the desk port.
# This script never stops cloudflared and never stops the Node desk.
# Requires SUPABASE_SERVICE_ROLE_KEY to PATCH night_desk_beacon. Without it, data/public-url.txt is still written.
# Port: DESK_PORT, then PORT, then PORT= in .env, then 4721.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
function Read-DotEnvPort([string]$File) {
  if (-not (Test-Path $File)) { return $null }
  foreach ($line in Get-Content -LiteralPath $File) {
    if ($line -match '^\s*PORT\s*=\s*["'']?(\d+)') { return $Matches[1] }
  }
  return $null
}
$Port = if ($env:DESK_PORT) { $env:DESK_PORT } elseif ($env:PORT) { $env:PORT } else { Read-DotEnvPort (Join-Path $Root ".env") }
if (-not $Port) { $Port = "4721" }
$Data = Join-Path $Root "data"
$Log = Join-Path $Data "cloudflared.log"
$UrlFile = Join-Path $Data "public-url.txt"
$Supabase = if ($env:SUPABASE_URL) { $env:SUPABASE_URL.TrimEnd("/") } else { "https://qivqvwlrmrgjpiqgvmzy.supabase.co" }
$BeaconId = if ($env:NIGHT_DESK_BEACON_ID) { $env:NIGHT_DESK_BEACON_ID } else { "phone" }

New-Item -ItemType Directory -Force -Path $Data | Out-Null

function Get-TunnelUrl([string]$Text) {
  $matches = [regex]::Matches($Text, "https://[a-z0-9-]+\.trycloudflare\.com")
  if ($matches.Count -eq 0) { return $null }
  return $matches[$matches.Count - 1].Value
}

function Publish-Beacon([string]$PublicUrl) {
  Set-Content -Path $UrlFile -Value $PublicUrl -Encoding ascii
  $key = $env:SUPABASE_SERVICE_ROLE_KEY
  if (-not $key) {
    Write-Host "SUPABASE_SERVICE_ROLE_KEY is unset. Wrote $UrlFile only."
    Write-Host "public url $PublicUrl"
    return
  }
  $headers = @{
    apikey = $key
    Authorization = "Bearer $key"
    "Content-Type" = "application/json"
    Prefer = "return=representation"
  }
  $patchUri = "$Supabase/rest/v1/night_desk_beacon?id=eq.$BeaconId"
  $patched = Invoke-RestMethod -Method Patch -Uri $patchUri -Headers $headers -Body (@{ public_url = $PublicUrl } | ConvertTo-Json)
  if (-not $patched) {
    $headers.Prefer = "resolution=merge-duplicates,return=minimal"
    Invoke-RestMethod -Method Post -Uri "$Supabase/rest/v1/night_desk_beacon" -Headers $headers -Body (@{ id = $BeaconId; public_url = $PublicUrl } | ConvertTo-Json) | Out-Null
  }
  Write-Host "beacon updated $PublicUrl"
}

$existing = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match "cloudflared" -and $_.CommandLine -match [regex]::Escape($Port)
})

if ($existing.Count -gt 0) {
  Write-Host "cloudflared already targets $Port (pid $($existing[0].ProcessId)). Leaving it running."
  $url = $null
  if (Test-Path $UrlFile) { $url = Get-TunnelUrl (Get-Content -Raw $UrlFile) }
  if (-not $url -and (Test-Path $Log)) { $url = Get-TunnelUrl (Get-Content -Raw $Log) }
  if ($url) { Publish-Beacon $url } else { Write-Host "No saved tunnel URL. The existing process was not restarted." }
  exit 0
}

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  Write-Error "cloudflared is not on PATH. Install it, then run this script again. The desk on port $Port was not touched."
}

Set-Content -Path $Log -Value "" -Encoding ascii
# cloudflared prints the hostname on stderr. One redirected log avoids starting a second tunnel later to "find" the URL.
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$($cloudflared.Source)`" tunnel --url http://127.0.0.1:$Port --no-autoupdate > `"$Log`" 2>&1") -WindowStyle Hidden -PassThru
Write-Host "started cloudflared wrapper pid $($proc.Id)"
$deadline = (Get-Date).AddSeconds(30)
$url = $null
while ((Get-Date) -lt $deadline) {
  if (Test-Path $Log) { $url = Get-TunnelUrl (Get-Content -Raw $Log) }
  if ($url) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $url) {
  Write-Error "cloudflared did not print a trycloudflare URL. See $Log. The process was left running."
}
Publish-Beacon $url
