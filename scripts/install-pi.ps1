$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeVersionText = (& node --version).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Node.js 22.19 or newer is required. Install Node.js, then run this setup again."
}

$nodeVersion = [version]($nodeVersionText.TrimStart("v"))
if ($nodeVersion -lt [version]"22.19.0") {
  throw "VoicePilot requires Node.js 22.19 or newer. Found $nodeVersionText."
}

$gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
$gitBash = $null
if ($gitCommand) {
  $gitInstallRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
  $candidate = Join-Path $gitInstallRoot "bin\bash.exe"
  if (Test-Path -LiteralPath $candidate) {
    $gitBash = $candidate
  }
}
if (-not $gitBash) {
  throw "Git for Windows is required for Pi's native Windows shell. Install Git for Windows, then run this setup again."
}

try {
  Resolve-DnsName -Name "registry.npmjs.org" -ErrorAction Stop | Out-Null
} catch {
  throw "Cannot resolve registry.npmjs.org. Restore internet/DNS access before setup; no package installation has been started."
}

Push-Location $repoRoot
try {
  $uiDependenciesPresent = Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\.bin\vite.cmd")
  $bridgeDependenciesPresent = Test-Path -LiteralPath (Join-Path $repoRoot "node_modules\.bin\tsx.cmd")
  if (-not ($uiDependenciesPresent -and $bridgeDependenciesPresent)) {
    Write-Host "Installing VoicePilot dependencies from the root lockfile..."
    & npm ci
    if ($LASTEXITCODE -ne 0) {
      throw "VoicePilot dependency installation failed."
    }
  } else {
    Write-Host "VoicePilot dependencies are already installed."
  }

  $piRoot = Join-Path $repoRoot "tools\pi"
  $piLockfile = Join-Path $piRoot "package-lock.json"
  if (-not (Test-Path -LiteralPath $piLockfile)) {
    throw "The pinned Pi runtime lockfile is missing at $piLockfile. Restore the project files before setup."
  }
  $piCommand = Join-Path $piRoot "node_modules\.bin\pi.cmd"
  $computerUseExtension = Join-Path $piRoot "node_modules\@amaster.ai\pi-computer-use\dist\index.js"
  $kiloCodeExtension = Join-Path $piRoot "node_modules\pi-kilocode\src\index.ts"
  if (-not ((Test-Path -LiteralPath $piCommand) -and (Test-Path -LiteralPath $computerUseExtension) -and (Test-Path -LiteralPath $kiloCodeExtension))) {
    Write-Host "Installing the pinned Pi CLI, computer-use extension, and KiloCode provider from the project lockfile..."
    & npm ci --prefix $piRoot --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "Pi/computer-use/KiloCode installation failed. Check internet access to registry.npmjs.org and run npm run setup:pi again."
    }
  } else {
    Write-Host "The pinned Pi CLI and computer-use extension are already installed."
  }
  if (-not (Test-Path -LiteralPath $piCommand)) {
    throw "Pi installed without the expected Windows command shim at $piCommand."
  }
  if (-not (Test-Path -LiteralPath $computerUseExtension)) {
    throw "The pinned computer-use extension is missing at $computerUseExtension."
  }
  if (-not (Test-Path -LiteralPath $kiloCodeExtension)) {
    throw "The pinned KiloCode provider extension is missing at $kiloCodeExtension."
  }

  $piSettingsDirectory = Join-Path $repoRoot ".pi"
  $piSettingsPath = Join-Path $piSettingsDirectory "settings.json"
  New-Item -ItemType Directory -Path $piSettingsDirectory -Force | Out-Null
  if (Test-Path -LiteralPath $piSettingsPath) {
    $existingSettings = Get-Content -LiteralPath $piSettingsPath -Raw | ConvertFrom-Json
    $piSettings = @{}
    foreach ($property in $existingSettings.PSObject.Properties) {
      $piSettings[$property.Name] = $property.Value
    }
  } else {
    $piSettings = @{}
  }
  $piSettings["pi-computer-use"] = @{
    mode = "bundled"
    confirmAppLaunch = $false
    confirmDangerousActions = $true
    toolProfile = "core"
  }
  $settingsJson = $piSettings | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($piSettingsPath, $settingsJson, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Configured the bundled Windows desktop driver, restricted its tool profile to core, and kept dangerous-action confirmations enabled."

  Write-Host "Pi setup is complete. Version:"
  & $piCommand --version
  if ($LASTEXITCODE -ne 0) {
    throw "Pi is installed but did not report its version successfully."
  }
  Write-Host "Git Bash found at $gitBash"
} finally {
  Pop-Location
}

