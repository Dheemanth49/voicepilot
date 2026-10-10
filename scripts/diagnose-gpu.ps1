param([string]$ProjectRoot)

$ErrorActionPreference = "Continue"
$repoRoot = if ($ProjectRoot) { (Resolve-Path -LiteralPath $ProjectRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$settings = @{}
$envFile = Join-Path $repoRoot ".env"
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim('"', "'") }
  }
}
function Get-Setting([string]$name, [string]$defaultValue = "") {
  if ($settings.ContainsKey($name) -and $settings[$name]) { return $settings[$name] }
  return $defaultValue
}
function Invoke-PythonInfo([string]$label, [string]$python, [string]$probe) {
  Write-Host "`n$label`n  Python: $(if ($python) { $python } else { 'not configured' })"
  if (-not $python -or -not (Test-Path -LiteralPath $python -PathType Leaf)) { Write-Host "  Status: unavailable"; return }
  $probePath = Join-Path ([IO.Path]::GetTempPath()) ("voicepilot-gpu-diagnose-" + [guid]::NewGuid().ToString("N") + ".py")
  try {
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
    $output = & $python $probePath 2>&1
    if ($LASTEXITCODE -eq 0) { $output | ForEach-Object { Write-Host "  $_" } }
    else { Write-Host "  Status: probe failed"; $output | ForEach-Object { Write-Host "  $_" } }
  } finally { Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue }
}

Write-Host "VoicePilot GPU diagnostics (read-only)"
Write-Host "--------------------------------------"
try {
  $adapters = @(Get-CimInstance Win32_VideoController -ErrorAction Stop)
  if ($adapters.Count) { foreach ($adapter in $adapters) { Write-Host "`nAdapter: $($adapter.Name)`n  Driver: $($adapter.DriverVersion)`n  Video memory: $($adapter.AdapterRAM) bytes" } }
  else { Write-Host "`nAdapter: unavailable" }
} catch { Write-Host "`nAdapter query unavailable: $($_.Exception.Message)" }

$nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if (-not $nvidiaSmi) { $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue }
if ($nvidiaSmi) {
  $gpuOutput = & $nvidiaSmi.Source --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1
  if ($LASTEXITCODE -eq 0) { Write-Host "`nnvidia-smi:"; $gpuOutput | ForEach-Object { Write-Host "  $_" } }
  else { Write-Host "`nnvidia-smi: query failed ($gpuOutput)" }
} else { Write-Host "`nnvidia-smi: unavailable" }

$fileSearchPython = Get-Setting "VOICEPILOT_FILE_SEARCH_PYTHON" (Join-Path $repoRoot ".voicepilot-file-search\venv\Scripts\python.exe")
Invoke-PythonInfo "File-search PyTorch" $fileSearchPython 'import torch; print("PyTorch:", torch.__version__); print("Built CUDA:", torch.version.cuda); print("CUDA available:", torch.cuda.is_available()); print("Device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "unavailable")'

$speechPython = Get-Setting "VOICEPILOT_PYTHON" (Join-Path $repoRoot ".venv\Scripts\python.exe")
$runtime = Get-Setting "VOICEPILOT_STT_CUDA_RUNTIME"
if ($runtime) { $previousCudaRuntime = $env:VOICEPILOT_STT_CUDA_RUNTIME; $env:VOICEPILOT_STT_CUDA_RUNTIME = $runtime }
try {
  Invoke-PythonInfo "Speech CTranslate2" $speechPython 'import os; handles = [os.add_dll_directory(p) for p in os.environ.get("VOICEPILOT_STT_CUDA_RUNTIME", "").split(os.pathsep) if os.name == "nt" and os.path.isdir(p)]; import ctranslate2; print("CTranslate2:", ctranslate2.__version__); print("CUDA compute types:", sorted(ctranslate2.get_supported_compute_types("cuda")))'
} finally {
  if ($runtime) { if ($null -eq $previousCudaRuntime) { Remove-Item Env:VOICEPILOT_STT_CUDA_RUNTIME -ErrorAction SilentlyContinue } else { $env:VOICEPILOT_STT_CUDA_RUNTIME = $previousCudaRuntime } }
}
Write-Host "  Requested speech device: $(Get-Setting 'VOICEPILOT_STT_DEVICE' 'auto')"
Write-Host "  CUDA DLL runtime: $(if ($runtime) { $runtime } else { 'not configured' })"
if ($runtime) {
  foreach ($directory in ($runtime -split [IO.Path]::PathSeparator)) {
    if (-not $directory) { continue }
    $dlls = @(Get-ChildItem -LiteralPath $directory -Filter '*.dll' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    Write-Host "  DLL directory $(if (Test-Path -LiteralPath $directory -PathType Container) { 'found' } else { 'missing' }): $directory"
    $foundCore = @($dlls | Where-Object { $_ -match '(?i)cublas64_12\.dll|cudnn64_9\.dll|cudart64_12\.dll' })
    if ($foundCore.Count) { Write-Host "    CUDA libraries: $($foundCore -join ', ')" }
  }
}

try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 -ErrorAction Stop
  Write-Host "`nActive bridge services:"
  Write-Host "  Speech: $(if ($health.providers.sttRuntime) { $health.providers.sttRuntime.device } else { 'not ready' })"
  Write-Host "  File search: $(if ($health.providers.fileSearchRuntime) { $health.providers.fileSearchRuntime.device } else { 'not ready' })"
  if ($health.providers.sttRuntime.fallbackReason) { Write-Host "  Speech fallback: $($health.providers.sttRuntime.fallbackReason)" }
  if ($health.providers.fileSearchRuntime.fallbackReason) { Write-Host "  File-search fallback: $($health.providers.fileSearchRuntime.fallbackReason)" }
} catch { Write-Host "`nBridge health: unavailable (start VoicePilot to report active worker devices)." }
Write-Host "`nDiagnostics did not install software or change settings."
