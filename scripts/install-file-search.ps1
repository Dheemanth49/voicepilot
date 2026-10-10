param([switch]$Gpu, [string]$ProjectRoot)

$ErrorActionPreference = "Stop"
$repoRoot = if ($ProjectRoot) { (Resolve-Path -LiteralPath $ProjectRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$setupCommon = Join-Path $PSScriptRoot "voicepilot-setup-common.psm1"
Import-Module $setupCommon -Force
$cpuVenvPath = Join-Path $repoRoot ".voicepilot-file-search\venv"
$gpuVenvPath = Join-Path $repoRoot ".voicepilot-file-search\venv-gpu"
$venvPath = if ($Gpu) { $gpuVenvPath } else { $cpuVenvPath }
$venvPython = Join-Path $venvPath "Scripts\python.exe"
$pythonPath = $null
$pythonProbe = "import sys; print(sys.executable if sys.version_info[:2] == (3, 12) else '')"

function Resolve-Python312([string]$commandPath, [string[]]$prefixArguments = @()) {
  if (-not $commandPath) { return $null }
  try {
    $candidate = (& $commandPath @prefixArguments -c $pythonProbe 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  } catch {
    # Broken Windows aliases and launchers can fail before returning an interpreter path.
  }
  return $null
}

$cudaFlavor = $null
if ($Gpu) {
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if (-not $nvidiaSmi) { $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue }
  if (-not $nvidiaSmi) { throw "VoicePilot could not find nvidia-smi. Install a compatible NVIDIA GeForce driver, open a new PowerShell window, and rerun npm run setup:file-search:gpu." }
  $gpuRows = @(& $nvidiaSmi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1)
  if ($LASTEXITCODE -ne 0 -or $gpuRows.Count -eq 0) { throw "VoicePilot could not query the NVIDIA GPU. Update/reinstall the NVIDIA driver and rerun GPU setup." }
  $gpuParts = @($gpuRows[0] -split ",\s*", 3)
  if ($gpuParts.Count -lt 3) { throw "nvidia-smi returned an unexpected GPU record: $($gpuRows[0])" }
  $gpuName, $driverVersion, $gpuMemory = $gpuParts
  $cudaFlavor = Get-VoicePilotCudaFlavor -DriverVersion $driverVersion
  if ($gpuName -match '(?i)RTX\s*50' -and $cudaFlavor -ne "cu130") {
    throw "The detected $gpuName requires the CUDA 13 build. Update its NVIDIA driver to version 580 or newer, then rerun GPU setup."
  }
  Write-Host "Detected $gpuName, driver $driverVersion, $gpuMemory. Selecting $cudaFlavor PyTorch wheels."
}

$launcher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($launcher) { $pythonPath = Resolve-Python312 $launcher.Source @("-3.12") }
if (-not $pythonPath) {
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($python) { $pythonPath = Resolve-Python312 $python.Source }
}
if (-not $pythonPath) {
  foreach ($candidatePath in @((Join-Path $cpuVenvPath "Scripts\python.exe"), (Join-Path $gpuVenvPath "Scripts\python.exe"))) {
    if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
      $pythonPath = Resolve-Python312 $candidatePath
      if ($pythonPath) { break }
    }
  }
}
if (-not $pythonPath) { throw "Semantic file search requires Python 3.12. Run npm run install:windows, open a new PowerShell window, then rerun the setup command." }

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
  & $pythonPath -m venv $venvPath
  if ($LASTEXITCODE -ne 0) { throw "Could not create VoicePilot's file-search Python environment." }
}
$requirementsName = if ($Gpu) { "requirements-gpu-$cudaFlavor.txt" } else { "requirements.txt" }
$requirementsPath = Join-Path $repoRoot "services\file_search\$requirementsName"
$env:HF_HOME = Join-Path $repoRoot ".data\voicepilot\models"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
New-Item -ItemType Directory -Path $env:HF_HOME -Force | Out-Null

Push-Location $repoRoot
try {
  & $venvPython -m pip install --upgrade -r $requirementsPath
  if ($LASTEXITCODE -ne 0) { throw "File-search dependencies could not be installed. The existing CPU environment was left unchanged; check network access and rerun setup." }

  Write-Host "Downloading and checking the local EmbeddingGemma 2 model. This may take several minutes."
  $previousDevicePreference = $env:VOICEPILOT_FILE_SEARCH_DEVICE
  $env:VOICEPILOT_FILE_SEARCH_DEVICE = if ($Gpu) { "cuda" } else { "cpu" }
  try {
    & $venvPython -c "from services.file_search.index import SentenceTransformerEmbedder; import os; model = SentenceTransformerEmbedder(device_preference=os.environ['VOICEPILOT_FILE_SEARCH_DEVICE']); model.encode(['VoicePilot local search setup check'], prompt_name='SearchQuery'); print('EmbeddingGemma 2 is ready on ' + model.active_device); assert model.active_device == os.environ['VOICEPILOT_FILE_SEARCH_DEVICE']"
    if ($LASTEXITCODE -ne 0) {
      $message = if ($Gpu) { "CUDA PyTorch or EmbeddingGemma GPU smoke check failed. The CPU environment and current .env selection were left unchanged. Check the NVIDIA driver and rerun npm run setup:file-search:gpu." } else { "EmbeddingGemma 2 could not be downloaded or loaded. Check available disk space and network access, then rerun npm run setup:file-search." }
      throw $message
    }
  } finally {
    if ($null -eq $previousDevicePreference) { Remove-Item Env:VOICEPILOT_FILE_SEARCH_DEVICE -ErrorAction SilentlyContinue }
    else { $env:VOICEPILOT_FILE_SEARCH_DEVICE = $previousDevicePreference }
  }

  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $repoRoot ".env.example") -Destination $envPath }
  $envValues = @{
    VOICEPILOT_FILE_SEARCH_ENABLED = "1"
    VOICEPILOT_FILE_SEARCH_PYTHON = $venvPython
    VOICEPILOT_FILE_SEARCH_DEVICE = if ($Gpu) { "auto" } else { "cpu" }
  }
  Set-VoicePilotEnvValues -Path $envPath -Values $envValues
} finally {
  Pop-Location
}

if ($Gpu) {
  Write-Host "GPU-enabled semantic file search is installed and enabled. Restart VoicePilot and run npm run diagnose:gpu to verify the active device."
} else {
  Write-Host "CPU semantic file search is installed and enabled. Restart VoicePilot, then add and index folders from Settings."
}
