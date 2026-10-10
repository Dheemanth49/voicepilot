param([string]$ProjectRoot, [string]$OutputDirectory)

$ErrorActionPreference = "Stop"
$repoRoot = if ($ProjectRoot) { (Resolve-Path -LiteralPath $ProjectRoot).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
if (-not $manifest.version) { throw "package.json does not declare the VoicePilot version." }
$requiredFiles = @("package.json", "package-lock.json", "README.md", ".env.example")
foreach ($name in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $name) -PathType Leaf)) { throw "Required project file is missing: $name" }
}
$sourceDirectories = @("apps", "packages", "scripts", "services", "tools\pi", "docs", "VoicePilot_Docs")
foreach ($name in $sourceDirectories) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $name) -PathType Container)) { throw "Required project folder is missing: $name" }
}
$rootFiles = @("package.json", "package-lock.json", "README.md", ".env.example", ".gitignore", "IMPLEMENTATION_STATUS.md")
$ignoredSegments = @(".git", ".data", ".pi", ".tmp", ".venv", ".npm", "venv", "node_modules", "dist", "coverage", ".artifacts", ".superpowers", "__pycache__")
$outputPath = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $repoRoot ".artifacts" }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$stage = Join-Path $repoRoot (".tmp\package-windows-" + [guid]::NewGuid().ToString("N"))
$payload = Join-Path $stage "VoicePilot"
New-Item -ItemType Directory -Path $payload -Force | Out-Null
try {
  $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
  foreach ($name in $rootFiles) {
    $filePath = Join-Path $repoRoot $name
    if (Test-Path -LiteralPath $filePath -PathType Leaf) { $files.Add((Get-Item -LiteralPath $filePath)) }
  }
  foreach ($directoryName in $sourceDirectories) {
    $source = Join-Path $repoRoot $directoryName
    $pending = [System.Collections.Generic.Queue[System.IO.DirectoryInfo]]::new()
    $pending.Enqueue([System.IO.DirectoryInfo](Get-Item -LiteralPath $source))
    while ($pending.Count -gt 0) {
      $directory = $pending.Dequeue()
      foreach ($entry in Get-ChildItem -LiteralPath $directory.FullName -Force) {
        $relative = $entry.FullName.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
        $segments = $relative -split '[\\/]'
        if ($segments | Where-Object { $ignoredSegments -contains $_ -or $_.StartsWith('.voicepilot-') }) { continue }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($entry.PSIsContainer) { $pending.Enqueue([System.IO.DirectoryInfo]$entry) }
        else { $files.Add([System.IO.FileInfo]$entry) }
      }
    }
  }
  if ($files.Count -eq 0) { throw "No source files were found to package." }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
    $destination = Join-Path $payload $relative
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
  }

  $archiveName = "VoicePilot-$($manifest.version)-windows.zip"
  $archivePath = Join-Path $outputPath $archiveName
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  Get-ChildItem -LiteralPath $payload -Force | Compress-Archive -DestinationPath $archivePath -CompressionLevel Optimal
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw "The source archive could not be created." }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($archivePath)
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  [IO.File]::WriteAllText("$archivePath.sha256", "$hash  $archiveName`n", [Text.UTF8Encoding]::new($false))
  Write-Host "Created $archivePath"
  Write-Host "SHA-256: $hash"
  Write-Host "Extract this archive, then run powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1"
} finally {
  if (Test-Path -LiteralPath $stage -PathType Container) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
