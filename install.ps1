$ErrorActionPreference = "Stop"

$repo = if ($env:RELAY_GITHUB_REPO) { $env:RELAY_GITHUB_REPO } else { "bencsn/relay" }
$version = if ($env:RELAY_VERSION) { $env:RELAY_VERSION } else { "latest" }
$installDir = if ($env:RELAY_INSTALL_DIR) {
  $env:RELAY_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "Relay\bin"
}
$artifact = "relay-host-windows-x64.zip"
$releaseUrl = if ($version -eq "latest") {
  "https://github.com/$repo/releases/latest/download"
} else {
  "https://github.com/$repo/releases/download/$version"
}

$temporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("relay-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryDir | Out-Null
try {
  $archive = Join-Path $temporaryDir $artifact
  $checksumFile = Join-Path $temporaryDir "SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$artifact" -OutFile $archive
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumFile
  $checksumLine = Get-Content $checksumFile | Where-Object { $_ -match "\s$([regex]::Escape($artifact))$" } | Select-Object -First 1
  if (-not $checksumLine) { throw "Release checksum is missing for $artifact." }
  $expected = ($checksumLine -split "\s+")[0].ToUpperInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToUpperInvariant()
  if ($actual -ne $expected) { throw "Checksum verification failed for $artifact." }

  if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh attestation verify $archive --repo $repo | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "GitHub build provenance verification failed." }
    Write-Host "Verified GitHub build provenance."
  } else {
    Write-Host "Verified SHA-256. Install GitHub CLI to verify build provenance as well."
  }

  Expand-Archive -Path $archive -DestinationPath $temporaryDir -Force
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Copy-Item (Join-Path $temporaryDir "relay-host-windows-x64.exe") (Join-Path $installDir "relay-host.exe") -Force
  Write-Host "Installed relay-host to $installDir\relay-host.exe"
  Write-Host "Add $installDir to PATH if it is not already present."
} finally {
  Remove-Item -Recurse -Force $temporaryDir -ErrorAction SilentlyContinue
}
