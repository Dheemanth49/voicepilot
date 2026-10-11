$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
function Get-ConfiguredValue([string]$name, [string]$defaultValue) {
  $processValue = [Environment]::GetEnvironmentVariable($name)
  if ($processValue) { return $processValue.Trim() }
  $existingEnvPath = Join-Path $repoRoot ".env"
  if (Test-Path -LiteralPath $existingEnvPath) {
    foreach ($line in Get-Content -LiteralPath $existingEnvPath) {
      if ($line -match ("^\s*" + [regex]::Escape($name) + "=(.*)$")) {
        $value = $Matches[1].Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        return $value
      }
    }
  }
  return $defaultValue
}

$modelId = Get-ConfiguredValue "VOICEPILOT_LOCAL_LLM_MODEL" "gemma4:e2b"
$baseUrl = (Get-ConfiguredValue "VOICEPILOT_LOCAL_LLM_BASE_URL" "http://127.0.0.1:11434/v1").TrimEnd("/")
$providerId = Get-ConfiguredValue "VOICEPILOT_LOCAL_LLM_PROVIDER" "ollama"
if ($providerId -ne "ollama") {
  throw "This setup command installs Ollama. Set VOICEPILOT_LOCAL_LLM_PROVIDER to ollama or configure another compatible provider manually."
}
if (-not $modelId -or $modelId -match '[\r\n"\\]') {
  throw "VOICEPILOT_LOCAL_LLM_MODEL must be a single Ollama model identifier."
}
try {
  $parsedBaseUrl = [Uri]$baseUrl
  if ($parsedBaseUrl.Scheme -notin @("http", "https") -or -not $parsedBaseUrl.IsLoopback) {
    throw "The local model endpoint must use a loopback URL."
  }
} catch {
  throw "VOICEPILOT_LOCAL_LLM_BASE_URL must be a valid local HTTP URL."
}

$ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaCommand) {
  $choice = Read-Host "Ollama is not installed. Install it with winget now? [y/N]"
  if ($choice -notmatch '^(y|yes)$') {
    throw "Ollama setup was skipped. Install Ollama, then rerun npm run setup:llm."
  }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "winget is unavailable. Install Ollama from https://ollama.com/download/windows, then rerun npm run setup:llm."
  }
  & winget.exe install --id Ollama.Ollama --exact --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Ollama installation failed. Install it from https://ollama.com/download/windows, then rerun npm run setup:llm."
  }
  $ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
  $ollamaExecutable = if ($ollamaCommand) { $ollamaCommand.Source } else { $null }
  if (-not $ollamaExecutable) {
    $ollamaCandidates = @(
      (Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"),
      (Join-Path $env:ProgramFiles "Ollama\ollama.exe")
    )
    $ollamaExecutable = $ollamaCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $ollamaExecutable) {
    throw "Ollama installed, but ollama.exe is not available in this PowerShell session. Open a new PowerShell window and rerun npm run setup:llm."
  }
} else {
  $ollamaExecutable = $ollamaCommand.Source
}

$installedModelLines = @(& $ollamaExecutable list 2>$null)
$modelAlreadyInstalled = $LASTEXITCODE -eq 0 -and @($installedModelLines | Where-Object {
  $columns = ("$_").Trim() -split '\s+'
  $columns.Count -gt 0 -and $columns[0] -eq $modelId
}).Count -gt 0
if ($modelAlreadyInstalled) {
  Write-Host "Local model $modelId is already installed; skipping download."
} else {
  Write-Host "Downloading the configured local model ($modelId). This may take several GB of disk space."
  & $ollamaExecutable pull $modelId
  if ($LASTEXITCODE -ne 0) {
    throw "Ollama could not download $modelId. Check network access and disk space, then rerun npm run setup:llm."
  }
}

$modelsUrl = "$baseUrl/models"
$modelAvailable = $false
try {
  $catalog = Invoke-RestMethod -Uri $modelsUrl -TimeoutSec 10
  $modelAvailable = @($catalog.data | Where-Object { $_.id -eq $modelId }).Count -gt 0
} catch {
  throw "Ollama installed $modelId, but the local OpenAI-compatible model endpoint did not respond at $modelsUrl. Make sure Ollama is running, then rerun setup."
}
if (-not $modelAvailable) {
  throw "The local model endpoint did not list $modelId at $modelsUrl. Check the Ollama model name and rerun setup."
}

$agentHome = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$modelsPath = Join-Path $agentHome "models.json"
New-Item -ItemType Directory -Path $agentHome -Force | Out-Null
$modelConfig = if (Test-Path -LiteralPath $modelsPath) {
  Get-Content -LiteralPath $modelsPath -Raw | ConvertFrom-Json
} else {
  [pscustomobject]@{}
}

$rootMap = @{}
foreach ($property in $modelConfig.PSObject.Properties) { $rootMap[$property.Name] = $property.Value }
$providersMap = @{}
if ($rootMap.ContainsKey("providers") -and $rootMap["providers"]) {
  foreach ($property in $rootMap["providers"].PSObject.Properties) { $providersMap[$property.Name] = $property.Value }
}
$ollamaMap = @{}
if ($providersMap.ContainsKey("ollama") -and $providersMap["ollama"]) {
  foreach ($property in $providersMap["ollama"].PSObject.Properties) { $ollamaMap[$property.Name] = $property.Value }
}
$existingModels = @($ollamaMap["models"] | Where-Object { $null -ne $_ })
if (-not ($existingModels | Where-Object { $_.id -eq $modelId })) {
  $existingModels += [pscustomobject]@{ id = $modelId }
}
$ollamaMap["baseUrl"] = $baseUrl
$ollamaMap["api"] = "openai-completions"
$ollamaMap["apiKey"] = "ollama"
$ollamaMap["models"] = $existingModels
$providersMap["ollama"] = $ollamaMap
$rootMap["providers"] = $providersMap
$modelsJson = $rootMap | ConvertTo-Json -Depth 50
[System.IO.File]::WriteAllText($modelsPath, $modelsJson, [System.Text.UTF8Encoding]::new($false))

$envPath = Join-Path $repoRoot ".env"
$envText = if (Test-Path -LiteralPath $envPath) { Get-Content -LiteralPath $envPath -Raw } else { Get-Content -LiteralPath (Join-Path $repoRoot ".env.example") -Raw }
$envLines = [System.Collections.Generic.List[string]]::new()
foreach ($line in ($envText -split "`r?`n")) { if ($line.Length -gt 0) { $envLines.Add($line) } }
foreach ($entry in @(
  @{ Name = "VOICEPILOT_LOCAL_LLM_PROVIDER"; Value = "ollama" },
  @{ Name = "VOICEPILOT_LOCAL_LLM_BASE_URL"; Value = $baseUrl },
  @{ Name = "VOICEPILOT_LOCAL_LLM_MODEL"; Value = $modelId }
)) {
  $pattern = "^\s*#?\s*" + [regex]::Escape($entry.Name) + "="
  $found = $false
  for ($index = 0; $index -lt $envLines.Count; $index++) {
    if ($envLines[$index] -match $pattern) {
      $envLines[$index] = "$($entry.Name)=$($entry.Value)"
      $found = $true
      break
    }
  }
  if (-not $found) { $envLines.Add("$($entry.Name)=$($entry.Value)") }
}
[System.IO.File]::WriteAllText($envPath, ($envLines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "Local LLM setup complete: $providerId/$modelId"
Write-Host "Pi model configuration: $modelsPath"
Write-Host "VoicePilot environment updated: $envPath"
Write-Host "Restart VoicePilot to use the local model. KiloCode remains the fallback when local inference is unavailable."
