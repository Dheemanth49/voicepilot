param([string]$ProjectRoot)

$ErrorActionPreference = "Stop"
$repoRoot = if ($ProjectRoot) { (Resolve-Path -LiteralPath $ProjectRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
Import-Module (Join-Path $PSScriptRoot "voicepilot-setup-common.psm1") -Force
$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if (-not $nvidiaSmi) { $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue }
if (-not $nvidiaSmi) { throw "An NVIDIA GPU driver is required for speech GPU setup. Install the GeForce driver, open a new terminal, and retry." }
$gpuInfo = @(& $nvidiaSmi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1)
if ($LASTEXITCODE -ne 0 -or $gpuInfo.Count -eq 0) { throw "Could not query the NVIDIA GPU. Update the driver and retry speech GPU setup." }
$gpu = ($gpuInfo[0] -split ",", 3 | ForEach-Object { $_.Trim() })
if ($gpu.Count -lt 3) { throw "nvidia-smi returned an unexpected adapter record: $($gpuInfo[0])" }
try { $driver = [version]::Parse($gpu[1]) } catch { throw "Could not parse NVIDIA driver version '$($gpu[1])'." }
if ($driver -lt [version]'525.0') { throw "NVIDIA driver $driver is too old for speech GPU setup. CUDA 12 requires driver 525 or newer; update the driver and retry." }
Write-Host "Detected $($gpu[0]), driver $($gpu[1]), $($gpu[2])."

$venv = Join-Path $repoRoot ".voicepilot-speech\venv-gpu"
$python = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  $pythonLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($pythonLauncher) { & $pythonLauncher.Source -3.12 -m venv $venv }
  else {
    $pythonLauncher = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $pythonLauncher) { throw "Python 3.12 was not found. Install it with npm run install:windows, then retry." }
    & $pythonLauncher.Source -m venv $venv
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not create VoicePilot's separate speech GPU environment." }
}
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Could not update pip in the isolated speech GPU environment." }
& $python -m pip install -r (Join-Path $repoRoot "services\speech\requirements-gpu.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned CUDA speech dependencies. CPU speech setup and settings remain unchanged." }

$sitePackages = Join-Path $venv "Lib\site-packages\nvidia"
$dllDirectories = @(
  (Join-Path $sitePackages "cublas\bin"),
  (Join-Path $sitePackages "cudnn\bin"),
  (Join-Path $sitePackages "cuda_runtime\bin")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container }
if (-not ($dllDirectories | Where-Object { $_ -like "*cublas*" }) -or -not ($dllDirectories | Where-Object { $_ -like "*cudnn*" })) {
  throw "The isolated environment is missing NVIDIA cuBLAS/cuDNN DLL directories. The CPU speech configuration remains selected."
}
$runtimePath = $dllDirectories -join [IO.Path]::PathSeparator
$previousPath = $env:PATH
$previousRuntime = $env:VOICEPILOT_STT_CUDA_RUNTIME
$previousDevice = $env:VOICEPILOT_STT_DEVICE
try {
  $env:VOICEPILOT_STT_CUDA_RUNTIME = $runtimePath
  $env:VOICEPILOT_STT_DEVICE = "cuda"
  $modelName = if ($env:VOICEPILOT_STT_MODEL) { $env:VOICEPILOT_STT_MODEL } else { "large-v3" }
  $probe = @'
import os
import sys
handles = [os.add_dll_directory(path) for path in os.environ["VOICEPILOT_STT_CUDA_RUNTIME"].split(os.pathsep) if os.path.isdir(path)]
import ctranslate2
from faster_whisper import WhisperModel
types = ctranslate2.get_supported_compute_types("cuda")
assert types, "CTranslate2 reports no supported CUDA compute types"
model = WhisperModel(os.environ.get("VOICEPILOT_STT_MODEL", "large-v3"), device="cuda", compute_type=os.environ.get("VOICEPILOT_STT_COMPUTE_TYPE", "default"))
print("Speech model loaded on CUDA (" + ", ".join(sorted(types)) + ").")
'@
  $probePath = Join-Path $repoRoot ".voicepilot-speech\gpu-smoke-check.py"
  [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
  try { & $python $probePath } finally { Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0) { throw "CUDA runtime or faster-whisper model check failed. CPU speech setup and settings remain unchanged." }
} finally {
  $env:PATH = $previousPath
  if ($null -eq $previousRuntime) { Remove-Item Env:VOICEPILOT_STT_CUDA_RUNTIME -ErrorAction SilentlyContinue } else { $env:VOICEPILOT_STT_CUDA_RUNTIME = $previousRuntime }
  if ($null -eq $previousDevice) { Remove-Item Env:VOICEPILOT_STT_DEVICE -ErrorAction SilentlyContinue } else { $env:VOICEPILOT_STT_DEVICE = $previousDevice }
}

$envPath = Join-Path $repoRoot ".env"
if (-not (Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $repoRoot ".env.example") -Destination $envPath }
Set-VoicePilotEnvValues -Path $envPath -Values @{
  VOICEPILOT_STT_ENABLED = "1"
  VOICEPILOT_PYTHON = $python
  VOICEPILOT_STT_DEVICE = "auto"
  VOICEPILOT_STT_CUDA_RUNTIME = $runtimePath
}
Write-Host "Speech CUDA runtime and model smoke check succeeded. Restart VoicePilot; CUDA DLL paths are scoped to its speech worker."
