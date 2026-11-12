# Removes FAI Browser as scripts/install.ps1 installed it (Windows). The installer copies this file to
# %LOCALAPPDATA%\fai-browser\uninstall.ps1:
#
#   powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\fai-browser\uninstall.ps1"
#
# It closes FAI Browser (Firefox with the FAI profile; your everyday Firefox is left alone), undoes the registration
# with Claude Code, Codex and OpenCode, stops the FAI service, removes Firefox's pairing helper, the FAI profile (its
# sign-ins and history), FAI's own Firefox copy, the private Node.js, the Start menu entry, the fai-browser command and
# the settings with the pairing secret (%APPDATA%\fai-browser). Set FAI_UNINSTALL_YES=1 to skip the question.
& {
  $ErrorActionPreference = 'Continue'
  $root = if ($env:FAI_INSTALL_ROOT) { $env:FAI_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'fai-browser' }
  $settings = Join-Path $env:APPDATA 'fai-browser'
  $profileDir = Join-Path $env:LOCALAPPDATA 'fai-browser\browser\profile'
  $cli = Get-ChildItem (Join-Path $root 'app') -Directory -ErrorAction SilentlyContinue | Sort-Object Name |
    ForEach-Object { Join-Path $_.FullName 'src\cli.js' } | Where-Object { Test-Path $_ } | Select-Object -Last 1
  $node = Get-ChildItem (Join-Path $root 'node') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'node.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1

  Write-Host 'This removes FAI Browser from this Windows account:'
  Write-Host "  $root  (the app, its Node.js, FAI's Firefox copy, the FAI profile with its sign-ins and history)"
  Write-Host "  $settings  (settings and the pairing secret)"
  Write-Host '  the Start menu entry, the fai-browser command, Firefox''s pairing helper and the coding-agent registrations'
  Write-Host 'Your everyday Firefox and its profile stay as they are.'
  if ($env:FAI_UNINSTALL_YES -ne '1') {
    $answer = Read-Host 'Remove FAI Browser? [y/N]'
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Nothing removed.'; return }
  }

  # FAI Browser windows: only the Firefox processes running the FAI profile.
  $fai = Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) }
  if ($fai) {
    Write-Host 'Closing FAI Browser...'
    $fai | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }

  if ($node -and $cli) {
    & $node $cli uninstall --host all | Out-Null
    & $node $cli daemon stop *> $null
    & $node $cli uninstall-native | Out-Null
    & $node $cli uninstall-launcher --yes *> $null
  } else {
    reg delete 'HKCU\Software\Mozilla\NativeMessagingHosts\fai_browser' /f *> $null
  }
  # Anything still running from the install folder (a pairing helper, the service).
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1

  Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'FAI Browser.lnk') -Force -ErrorAction SilentlyContinue
  $bin = Join-Path $root 'bin'
  $path = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($path) {
    $parts = $path.Split(';') | Where-Object { $_ -and $_ -ne $bin }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  }

  Set-Location $env:USERPROFILE
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $settings -Recurse -Force -ErrorAction SilentlyContinue
  if ((Test-Path $root) -or (Test-Path $settings)) {
    Write-Host "Some files are still in use; close FAI Browser and remove what is left of $root and $settings by hand."
  } else {
    Write-Host 'FAI Browser is removed. Restart your coding agent so it forgets the FAI Browser tools.'
  }
}
