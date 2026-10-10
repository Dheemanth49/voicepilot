$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = Join-Path $repoRoot ".voicepilot-laya"
$sourceRoot = Join-Path $runtimeRoot "source"
$venvRoot = Join-Path $runtimeRoot "venv"
$upstream = "https://github.com/ChenneyZhuang/laya-browser-agent.git"
$revision = "56f997b5d3650219729daefb1d0746c588077370"

$gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCommand) { throw "Git for Windows is required. Run npm run install:windows, reopen PowerShell, then retry." }

$pythonPath = $null
$launcher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($launcher) {
  try {
    $candidate = (& $launcher.Source -3.12 -c "import sys; print(sys.executable)" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $pythonPath = $candidate }
  } catch {
    # The Python Launcher may be installed without a registered 3.12 runtime.
    # Probe python.exe below so the installer can report the missing version cleanly.
  }
}
if (-not $pythonPath) {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) {
    $candidateVersion = (& $pythonCommand.Source --version 2>&1 | Out-String).Trim()
    if ($candidateVersion -match "^Python 3\.12\.") {
      $candidate = (& $pythonCommand.Source -c "import sys; print(sys.executable)" 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $pythonPath = $candidate }
    }
  }
}
if (-not $pythonPath) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) { throw "Laya's Windows PyTorch runtime requires Python 3.12. Install it from python.org or install Windows App Installer (winget), then rerun npm run setup:laya." }

  Write-Host "Python 3.12 was not found. Installing the Laya prerequisite with winget..."
  & $winget.Source install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget could not install Python 3.12. Install Python.Python.3.12 manually, open a new PowerShell window, and rerun npm run setup:laya." }

  if ($launcher) {
    try {
      $candidate = (& $launcher.Source -3.12 -c "import sys; print(sys.executable)" 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $pythonPath = $candidate }
    } catch {
      # The launcher may need a new shell to refresh its registered runtimes.
    }
  }
  if (-not $pythonPath) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) {
      $candidateVersion = (& $pythonCommand.Source --version 2>&1 | Out-String).Trim()
      if ($candidateVersion -match "^Python 3\.12\.") {
        $candidate = (& $pythonCommand.Source -c "import sys; print(sys.executable)" 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $pythonPath = $candidate }
      }
    }
  }
  if (-not $pythonPath) { throw "Python 3.12 was installed, but this PowerShell session cannot find it yet. Open a new terminal and rerun npm run setup:laya." }
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
if (Test-Path -LiteralPath $sourceRoot) {
  $topLevel = (& $gitCommand.Source -C $sourceRoot rev-parse --show-toplevel 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($topLevel) -ne [IO.Path]::GetFullPath($sourceRoot)) {
    throw "$sourceRoot already exists but is not the expected Git checkout. Move it aside before running setup again."
  }
  $remote = (& $gitCommand.Source -C $sourceRoot remote get-url origin 2>$null | Out-String).Trim()
  if ($remote -ne $upstream) { throw "The existing Laya checkout has a different origin. Move it aside before running setup again." }
  $dirty = (& $gitCommand.Source -C $sourceRoot status --porcelain 2>&1 | Out-String).Trim()
  if ($dirty) { throw "The existing Laya checkout has local changes. Preserve or commit them before rerunning setup." }
} else {
  & $gitCommand.Source clone --no-checkout $upstream $sourceRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not clone laya-browser-agent. Check network access and retry." }
}

& $gitCommand.Source -C $sourceRoot fetch --depth 1 origin $revision
if ($LASTEXITCODE -ne 0) { throw "Could not fetch the pinned Laya source revision $revision." }
& $gitCommand.Source -C $sourceRoot checkout --detach $revision
if ($LASTEXITCODE -ne 0) { throw "Could not check out the pinned Laya source revision $revision." }

if (-not (Test-Path -LiteralPath (Join-Path $venvRoot "Scripts\python.exe"))) {
  & $pythonPath -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not create the isolated Laya Python environment." }
}
$venvPython = Join-Path $venvRoot "Scripts\python.exe"
$venvVersion = (& $venvPython --version 2>&1 | Out-String).Trim()
if ($venvVersion -notmatch "^Python 3\.12\.") { throw "The existing Laya environment uses $venvVersion. Remove .voicepilot-laya/venv or preserve it elsewhere, then rerun setup with Python 3.12 installed." }
Push-Location $sourceRoot
try {
  & $venvPython -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw "Could not upgrade pip in the Laya environment." }
  & $venvPython -m pip install -e ".[torch,cdp]"
  if ($LASTEXITCODE -ne 0) { throw "Could not install Laya and its browser extras. Check internet access, disk space, and Python compatibility." }
  & $venvPython -m pip freeze | Set-Content -LiteralPath (Join-Path $runtimeRoot "requirements.lock.txt") -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw "Could not record the installed Laya dependency versions." }
} finally {
  Pop-Location
}

$installedRevision = (& $gitCommand.Source -C $sourceRoot rev-parse HEAD | Out-String).Trim()
$pythonVersion = (& $venvPython --version 2>&1 | Out-String).Trim()
@{ upstream = $upstream; revision = $installedRevision; python = $pythonVersion; extras = @("torch", "cdp") } |
  ConvertTo-Json -Depth 4 |
  Set-Content -LiteralPath (Join-Path $runtimeRoot "runtime.json") -Encoding utf8

Write-Host "Pinned Laya runtime installed in $runtimeRoot. No browser was downloaded. Run npm run start:browser to launch visible Brave with CDP and configure the local endpoint."
