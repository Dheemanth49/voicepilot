param([string]$ProjectRoot)

$ErrorActionPreference = "Stop"

$repoRoot = if ($ProjectRoot) { (Resolve-Path -LiteralPath $ProjectRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

function Test-Node {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $command) { return $false }
  $versionText = (& $command.Source --version).Trim().TrimStart("v")
  try { return ([version]$versionText -ge [version]"22.19.0") } catch { return $false }
}

function Test-GitBash {
  $command = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $command) { return $false }
  $gitRoot = Split-Path -Parent (Split-Path -Parent $command.Source)
  return Test-Path -LiteralPath (Join-Path $gitRoot "bin\bash.exe")
}

function Test-Python {
  $command = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($command) {
    try {
      $runtimePath = (& $command.Source -3.12 -c "import sys; print(sys.executable)" 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { return $true }
    } catch {
      # The Python Launcher may be installed without a registered 3.12 runtime.
      # In that case, probe python.exe below instead of aborting setup.
    }
  }
  $command = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $command) { return $false }
  try {
    $versionText = (& $command.Source --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch "Python 3\.12\.") { return $false }
    $runtimePath = (& $command.Source -c "import sys; print(sys.executable)" 2>&1 | Out-String).Trim()
    return $LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $runtimePath -PathType Leaf)
  } catch {
    return $false
  }
}

if ([Environment]::OSVersion.Version.Build -lt 22000) { throw "VoicePilot supports Windows 11 or newer." }
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue

$packages = @()
if (-not (Test-Node)) { $packages += "OpenJS.NodeJS.LTS" }
if (-not (Test-GitBash)) { $packages += "Git.Git" }
if (-not (Test-Python)) { $packages += "Python.Python.3.12" }

if ($packages.Count -gt 0) {
  if (-not $winget) { throw "Windows Package Manager (winget) is required to install missing prerequisites. Install or update App Installer, then rerun this script." }
  foreach ($packageId in $packages) {
    Write-Host "Installing prerequisite $packageId with winget..."
    & $winget.Source install --id $packageId --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $packageId. Install it manually and rerun this script." }
  }
  throw "Prerequisites were installed. Close this terminal, open a new PowerShell window in $repoRoot, and rerun: npm run install:windows"
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".env"))) {
  Copy-Item -LiteralPath (Join-Path $repoRoot ".env.example") -Destination (Join-Path $repoRoot ".env")
}

Write-Host "Installing VoicePilot, Pi, and the Windows computer-use extension..."
Push-Location $repoRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "package-lock.json") -PathType Leaf)) {
    throw "The VoicePilot root package-lock.json is missing. Re-extract the complete project folder and rerun setup."
  }
  Write-Host "Installing the locked bridge and UI dependencies..."
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw "VoicePilot dependencies could not be installed with npm ci. Check network access and rerun this setup command." }

  & npm.cmd run setup:pi
  if ($LASTEXITCODE -ne 0) { throw "VoicePilot/Pi setup failed. Resolve the reported prerequisite or network issue and rerun this command." }

  $envPath = Join-Path $repoRoot ".env"
  $envText = Get-Content -LiteralPath $envPath -Raw
  $answer = Read-Host "Install local faster-whisper speech recognition now? It downloads Python packages and a large model on first use [Y/n]"
  if ($answer -notmatch "^(n|no)$") {
    & npm.cmd run setup:speech
    if ($LASTEXITCODE -ne 0) { throw "Speech setup failed. Pi remains installed; fix Python/network access and run npm run setup:speech." }
    if ($envText -match "(?m)^VOICEPILOT_STT_ENABLED=") {
      $envText = [regex]::Replace($envText, "(?m)^VOICEPILOT_STT_ENABLED=.*$", "VOICEPILOT_STT_ENABLED=1")
    } else {
      $envText += "`r`nVOICEPILOT_STT_ENABLED=1`r`n"
    }
    [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
  }

  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if (-not $nvidiaSmi) { $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue }
  $fileSearchSetupCommand = if ($nvidiaSmi) { "setup:file-search:gpu" } else { "setup:file-search" }
  $fileSearchPrompt = if ($nvidiaSmi) {
    "Install local semantic file search now? NVIDIA GPU detected; the installer will use CUDA. Type CPU to force CPU mode [y/N]"
  } else {
    "Install local semantic file search now? No NVIDIA GPU was detected, so it will use CPU mode [y/N]"
  }
  $fileSearchAnswer = Read-Host $fileSearchPrompt
  if ($fileSearchAnswer -match "^(y|yes|cpu)$") {
    if ($fileSearchAnswer -match "^cpu$") { $fileSearchSetupCommand = "setup:file-search:cpu" }
    & npm.cmd run $fileSearchSetupCommand
    if ($LASTEXITCODE -ne 0) { throw "Semantic file-search setup failed. Pi and VoicePilot remain installed; check Python 3.12, disk space, and network access, then run npm run $fileSearchSetupCommand." }
    $envText = Get-Content -LiteralPath $envPath -Raw
  }
  if ($envText -match "(?m)^VOICEPILOT_GLOBAL_HOTKEY_ENABLED=") {
    $envText = [regex]::Replace($envText, "(?m)^VOICEPILOT_GLOBAL_HOTKEY_ENABLED=.*$", "VOICEPILOT_GLOBAL_HOTKEY_ENABLED=1")
  } else {
    $envText += "VOICEPILOT_GLOBAL_HOTKEY_ENABLED=1`r`n"
  }
    [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
} finally {
  Pop-Location
}

Write-Host "Setup complete. Run the Pi CLI once to configure a model and trust this project:" -ForegroundColor Green
Write-Host "  .\tools\pi\node_modules\.bin\pi.cmd"
Write-Host "Then start VoicePilot with: npm run dev"
