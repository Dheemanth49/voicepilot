param(
  [Parameter()]
  [ValidateRange(1024, 65535)]
  [int]$Port = 9222,

  [Parameter()]
  [ValidateRange(1, 65535)]
  [int]$UiPort = 5173,

  [Parameter()]
  [switch]$UseVoicePilotProfile
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$endpoint = "http://127.0.0.1:$Port"
$versionUrl = "$endpoint/json/version"
$uiUrl = "http://127.0.0.1:$UiPort"
$allowedCdpOrigin = "--remote-allow-origins=http://127.0.0.1:$Port"

function Open-VoicePilotUiTab {
  $newTabUrl = "$endpoint/json/new?$([uri]::EscapeDataString($uiUrl))"
  try {
    $null = Invoke-WebRequest -Uri $newTabUrl -Method Put -TimeoutSec 5
    Write-Host "Opened the VoicePilot UI in Brave: $uiUrl"
  } catch {
    throw "CDP is ready, but Brave could not open the VoicePilot UI at $uiUrl. Make sure npm run dev is running, then rerun npm run start:browser. $($_.Exception.Message)"
  }
}

function Find-VoicePilotUiUrl {
  $candidatePorts = @($UiPort)
  $devInfoPath = Join-Path $repoRoot ".voicepilot-dev.json"
  if (Test-Path -LiteralPath $devInfoPath -PathType Leaf) {
    try {
      $devInfo = Get-Content -LiteralPath $devInfoPath -Raw | ConvertFrom-Json
      if ($devInfo.uiOrigin -match '^http://127\.0\.0\.1:(\d{1,5})$') {
        $candidatePorts += [int]$Matches[1]
      }
    } catch {
      Write-Verbose "Ignoring invalid VoicePilot dev-server metadata."
    }
  }
  try {
    $candidatePorts += @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") -and $_.LocalPort -ge 5173 -and $_.LocalPort -le 5272 } |
      Select-Object -ExpandProperty LocalPort -Unique |
      Sort-Object)
  } catch {
    # Keep the documented default when listener discovery is unavailable.
  }

  foreach ($candidatePort in ($candidatePorts | Select-Object -Unique)) {
    try {
      $page = Invoke-WebRequest -Uri "http://127.0.0.1:$candidatePort" -TimeoutSec 1 -UseBasicParsing
      if ($page.StatusCode -eq 200 -and $page.Content -match "@vite/client") {
        return "http://127.0.0.1:$candidatePort"
      }
    } catch {
      # Ignore non-HTTP listeners and continue looking for Vite.
    }
  }
  throw "VoicePilot's Vite page was not found. Start npm run dev, keep it running, and rerun npm run start:browser."
}

$uiUrl = Find-VoicePilotUiUrl

function Set-VoicePilotBrowserEndpoint {
  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    Copy-Item -LiteralPath (Join-Path $repoRoot ".env.example") -Destination $envPath
  }
  $content = [System.IO.File]::ReadAllText($envPath)
  $setting = "VOICEPILOT_BROWSER_CDP_ENDPOINT=$endpoint"
  if ($content -match "(?m)^VOICEPILOT_BROWSER_CDP_ENDPOINT=") {
    $content = [regex]::Replace($content, "(?m)^VOICEPILOT_BROWSER_CDP_ENDPOINT=.*$", $setting)
  } else {
    $content = $content.TrimEnd() + "`r`n$setting`r`n"
  }
  [System.IO.File]::WriteAllText($envPath, $content, [System.Text.UTF8Encoding]::new($false))
}

function Get-BraveExecutable {
  $candidates = @(
    (Join-Path $env:ProgramFiles "BraveSoftware\Brave-Browser\Application\brave.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "BraveSoftware\Brave-Browser\Application\brave.exe"),
    (Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\Application\brave.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
  if ($candidates.Count -gt 0) { return ($candidates | Select-Object -First 1) }
  $command = Get-Command brave.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Brave Browser was not found. Install Brave, then rerun npm run start:browser."
}

try {
  $existingEndpoint = Invoke-RestMethod -Uri $versionUrl -TimeoutSec 2
  if (-not $existingEndpoint.Browser -or $existingEndpoint.Browser -match "headless") {
    throw "The service on port $Port is not a visible CDP browser."
  }
  Set-VoicePilotBrowserEndpoint
  Open-VoicePilotUiTab
  Write-Host "Using the existing visible browser CDP endpoint at $endpoint."
  Write-Host "Restart VoicePilot after npm run start:browser so the bridge loads this setting."
  exit 0
} catch {
  if ($_.Exception.Message -match "not a visible CDP browser") { throw }
}

$braveProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'brave.exe'" -ErrorAction SilentlyContinue)
if ($braveProcesses.Count -gt 0 -and -not $UseVoicePilotProfile) {
  throw "Brave is already running without a reachable CDP endpoint. VoicePilot cannot add CDP after launch. Save your work, close Brave yourself, then rerun this command. To leave normal Brave open, rerun with -UseVoicePilotProfile; that opens a separate persistent VoicePilot profile."
}

$bravePath = Get-BraveExecutable
$arguments = @(
  "--remote-debugging-port=$Port",
  "--remote-debugging-address=127.0.0.1",
  $allowedCdpOrigin,
  "--new-window",
  $uiUrl
)
$profileDirectory = $null
if ($UseVoicePilotProfile) {
  $profileDirectory = Join-Path $env:LOCALAPPDATA "VoicePilot\BraveCdpProfile"
  New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
  $arguments = @(
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    $allowedCdpOrigin,
    "--user-data-dir=`"$profileDirectory`"",
    "--new-window",
    $uiUrl
  )
}

$null = Start-Process -FilePath $bravePath -ArgumentList $arguments -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(15)
$browserInfo = $null
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $browserInfo = Invoke-RestMethod -Uri $versionUrl -TimeoutSec 2
    if ($browserInfo.Browser -and $browserInfo.Browser -notmatch "headless") { break }
    Start-Sleep -Milliseconds 500
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if (-not $browserInfo -or -not $browserInfo.Browser -or $browserInfo.Browser -match "headless") {
  if ($UseVoicePilotProfile) {
    throw "Brave opened visibly, but its CDP endpoint did not become ready at $endpoint. Check whether another service uses port $Port."
  }
  throw "Brave opened visibly with your normal profile, but CDP did not become available. Chromium-based browsers may ignore remote debugging on the default profile. If you accept a separate persistent VoicePilot profile, close this Brave window and rerun: npm run start:browser -- -UseVoicePilotProfile"
}

Set-VoicePilotBrowserEndpoint
Open-VoicePilotUiTab
Write-Host "Brave is open visibly and CDP is ready at $endpoint."
if ($UseVoicePilotProfile) {
  Write-Host "VoicePilot profile: $profileDirectory"
  Write-Host "Sign into the sites you want VoicePilot to use in this profile once."
} else {
  Write-Host "Using Brave's normal profile."
}
Write-Host "The CDP endpoint was saved to .env. Restart VoicePilot to load it."
