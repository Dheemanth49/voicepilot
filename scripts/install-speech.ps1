$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pythonPath = $null
$pythonProbe = "import sys; print(sys.executable if sys.version_info >= (3, 10) else '')"

function Resolve-PythonInterpreter([string]$commandPath, [string[]]$prefixArguments = @()) {
  if (-not $commandPath) { return $null }
  try {
    $candidate = (& $commandPath @prefixArguments -c $pythonProbe 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  } catch {
    # Broken Windows execution aliases and Launchers can report stderr as a
    # terminating PowerShell error. Try the next known interpreter candidate.
  }
  return $null
}

$launcher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($launcher) {
  $pythonPath = Resolve-PythonInterpreter $launcher.Source @("-3.12")
}
if (-not $pythonPath) {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) { $pythonPath = Resolve-PythonInterpreter $pythonCommand.Source }
}
if (-not $pythonPath) {
  $workspaceCandidates = @(
    (Join-Path $repoRoot ".voicepilot-laya\venv\Scripts\python.exe"),
    (Join-Path $repoRoot ".voicepilot-python\Scripts\python.exe"),
    (Join-Path $repoRoot ".venv\Scripts\python.exe")
  )
  foreach ($candidatePath in $workspaceCandidates) {
    if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
      $pythonPath = Resolve-PythonInterpreter $candidatePath
      if ($pythonPath) { break }
    }
  }
}
if (-not $pythonPath) { throw "A working Python 3.10 or newer interpreter was not found. Install Python with npm run install:windows, open a new PowerShell window, then rerun npm run setup:speech." }
$venvPath = Join-Path $repoRoot ".venv"
& $pythonPath -m venv $venvPath
if ($LASTEXITCODE -ne 0) { throw "Could not create VoicePilot's local Python environment." }

$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Python pip could not be upgraded." }
& $venvPython -m pip install faster-whisper==1.2.1 "av<19"
if ($LASTEXITCODE -ne 0) { throw "faster-whisper could not be installed. Check internet access and Python compatibility." }

Write-Host "Speech runtime installed. Copy .env.example to .env (if needed) and set VOICEPILOT_STT_ENABLED=1."
Write-Host "The default faster-whisper large-v3 model downloads on first use and needs several GB of disk space."
