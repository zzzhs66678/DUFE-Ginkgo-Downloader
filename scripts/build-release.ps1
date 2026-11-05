$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
$releaseDirectory = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$archive = Join-Path $releaseDirectory "DUFE-Ginkgo-Downloader-v$($manifest.version).zip"
$files = @('manifest.json', 'content.js', 'pageHook.js', 'styles.css', 'background.js', 'README.md') | ForEach-Object { Join-Path $projectRoot $_ }
Compress-Archive -LiteralPath $files -DestinationPath $archive -Force
Write-Output $archive
