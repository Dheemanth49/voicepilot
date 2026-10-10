function Get-VoicePilotCudaFlavor {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$DriverVersion)

  try { $driver = [version]::Parse($DriverVersion.Trim()) }
  catch { throw "Could not parse NVIDIA driver version '$DriverVersion'." }

  if ($driver -ge [version]'580.0') { return 'cu130' }
  if ($driver -ge [version]'525.0') { return 'cu126' }
  throw "NVIDIA driver $driver is too old for VoicePilot's supported CUDA wheels. Install a driver version 525 or newer, then rerun GPU setup."
}

function Set-VoicePilotEnvValues {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][hashtable]$Values
  )

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $newline = [Environment]::NewLine
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $text = [System.IO.File]::ReadAllText($Path)
    if ($text.Contains("`r`n")) { $newline = "`r`n" } else { $newline = "`n" }
    $lines = [System.Text.RegularExpressions.Regex]::Split($text, "\r?\n")
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
      $lines = $lines[0..($lines.Count - 2)]
    }
  } else {
    $lines = @()
  }

  $keys = @{}
  foreach ($key in $Values.Keys) {
    if ($key -notmatch '^[A-Z][A-Z0-9_]*$') { throw "Invalid VoicePilot environment key '$key'." }
    $keys[$key] = $true
  }
  $written = @{}
  $updated = [System.Collections.Generic.List[string]]::new()
  foreach ($line in $lines) {
    $matched = $false
    foreach ($key in $Values.Keys) {
      if ($line -match "^\s*$([regex]::Escape($key))=") {
        if (-not $written.ContainsKey($key)) {
          $updated.Add("$key=$($Values[$key])")
          $written[$key] = $true
        }
        $matched = $true
        break
      }
    }
    if (-not $matched) { $updated.Add($line) }
  }
  foreach ($key in $Values.Keys) {
    if (-not $written.ContainsKey($key)) { $updated.Add("$key=$($Values[$key])") }
  }

  $temporaryPath = Join-Path $directory ("." + [System.IO.Path]::GetRandomFileName() + ".tmp")
  try {
    [System.IO.File]::WriteAllText($temporaryPath, ($updated -join $newline) + $newline, [System.Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } else {
      [System.IO.File]::Move($temporaryPath, $Path)
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

Export-ModuleMember -Function Get-VoicePilotCudaFlavor, Set-VoicePilotEnvValues
