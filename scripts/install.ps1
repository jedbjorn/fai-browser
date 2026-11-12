# FAI Browser for Windows: one command, Firefox only, set up for you.
#
#   irm https://raw.githubusercontent.com/jedbjorn/fai-browser/main/scripts/install.ps1 | iex
#
# Everything is per user (no administrator rights, no Developer mode):
#   1. Node.js: the official LTS build from nodejs.org (SHA256 checked against SHASUMS256.txt), private to FAI Browser
#      in %LOCALAPPDATA%\fai-browser\node\<version>. A Node you already have is neither used nor changed.
#   2. FAI Browser, the latest GitHub release, in %LOCALAPPDATA%\fai-browser\app\<version>-<time>: a new folder each
#      run, so an update never has to replace files a running FAI Browser, service or agent still uses (older folders
#      are removed once nothing holds them).
#   3. Its setup (scripts/setup.mjs --yes --download-firefox): the pairing secret, Firefox's pairing helper, the FAI
#      service, registration with each coding agent found (Claude Code, Codex, OpenCode), and FAI Browser itself:
#      official Firefox (yours, or Mozilla's downloaded into its own folder) with a separate FAI profile and the signed
#      add-on, paired.
#   4. A "FAI Browser" Start menu entry and the `fai-browser` command (%LOCALAPPDATA%\fai-browser\bin on your PATH).
#
# Run it again to update. Remove everything with:
#   powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\fai-browser\uninstall.ps1"
#
# Run it in a normal PowerShell window: an elevated one ("Run as administrator") is refused, since FAI's local service
# would then run with administrator rights.
#
# Overrides (environment variables): FAI_INSTALL_REF (a release tag from v0.9.0 on, or a branch), FAI_INSTALL_ZIP (a
# local source zip instead of a download), FAI_INSTALL_NO_SETUP=1 (install files only), FAI_INSTALL_ROOT,
# FAI_INSTALL_ALLOW_ADMIN=1 (run elevated anyway; for throwaway machines and CI only).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'jedbjorn/fai-browser'
  $MinNodeMajor = 22

  function Say([string]$Text) { Write-Host $Text }
  function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }

  function Get-Text([string]$Url) {
    (Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers @{ 'User-Agent' = 'fai-browser-installer' }).Content
  }

  function Save-Url([string]$Url, [string]$Path) {
    Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -Headers @{ 'User-Agent' = 'fai-browser-installer' }
  }

  function Install-Node([string]$Root) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $index = Get-Text 'https://nodejs.org/dist/index.json' | ConvertFrom-Json
    $release = $index | Where-Object {
      $_.lts -and ([int]($_.version.TrimStart('v').Split('.')[0]) -ge $MinNodeMajor) -and ($_.files -contains "win-$arch-zip")
    } | Select-Object -First 1
    if (-not $release) { throw "No Node.js LTS build for Windows $arch on nodejs.org" }
    $version = $release.version
    $dir = Join-Path $Root "node\$version"
    $exe = Join-Path $dir 'node.exe'
    if (Test-Path $exe) {
      Say "Node.js $version (LTS) is already in $dir."
      return $exe
    }
    Say "Downloading Node.js $version (LTS) from nodejs.org..."
    $name = "node-$version-win-$arch"
    $tmp = Join-Path $Root 'tmp'
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp "$name.zip"
    Save-Url "https://nodejs.org/dist/$version/$name.zip" $zip
    $sums = Get-Text "https://nodejs.org/dist/$version/SHASUMS256.txt"
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    $expected = $null
    foreach ($line in ($sums -split "`n")) {
      if ($line -match "^([0-9a-f]{64})\s+$([regex]::Escape("$name.zip"))\s*$") { $expected = $Matches[1]; break }
    }
    if (-not $expected -or $expected -ne $hash) { throw "Node.js download does not match SHASUMS256.txt ($name.zip)" }
    Say 'Checksum matches SHASUMS256.txt.'
    $unpack = Join-Path $tmp $name
    if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    New-Item -ItemType Directory -Force (Split-Path $dir) | Out-Null
    Move-Item $unpack $dir
    Remove-Item $zip -Force
    return $exe
  }

  function Get-Source([string]$Root) {
    $tmp = Join-Path $Root 'tmp'
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp 'fai-browser-source.zip'
    if ($env:FAI_INSTALL_ZIP) {
      Say "Using the source zip $env:FAI_INSTALL_ZIP."
      Copy-Item $env:FAI_INSTALL_ZIP $zip -Force
    } else {
      $ref = $env:FAI_INSTALL_REF
      if (-not $ref) {
        $ref = (Get-Text "https://api.github.com/repos/$Repo/releases/latest" | ConvertFrom-Json).tag_name
        if (-not $ref) { throw 'Could not find the latest FAI Browser release on GitHub' }
      }
      $kind = if ($ref -match '^v\d+\.\d+\.\d+') { 'tags' } else { 'heads' }
      Say "Downloading FAI Browser $ref from github.com/$Repo..."
      Save-Url "https://github.com/$Repo/archive/refs/$kind/$ref.zip" $zip
    }
    $unpack = Join-Path $tmp 'source'
    if (Test-Path $unpack) { Remove-Item $unpack -Recurse -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpack)
    Remove-Item $zip -Force
    # A GitHub archive has one top folder; a plain zip of a checkout has none.
    $top = if (Test-Path (Join-Path $unpack 'package.json')) { Get-Item $unpack } else { Get-ChildItem $unpack -Directory | Select-Object -First 1 }
    if (-not $top -or -not (Test-Path (Join-Path $top.FullName 'src\cli.js'))) { throw 'The FAI Browser source has no src\cli.js' }
    return $top.FullName
  }

  function Write-Icon([string]$Png, [string]$Ico) {
    # An .ico holding one PNG image (Windows Vista and later read it).
    $bytes = [IO.File]::ReadAllBytes($Png)
    $out = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter($out)
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
    $w.Write([byte]128); $w.Write([byte]128); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$bytes.Length); $w.Write([uint32]22)
    $w.Write($bytes)
    $w.Flush()
    [IO.File]::WriteAllBytes($Ico, $out.ToArray())
  }

  function Add-UserPath([string]$Dir) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($current) { $parts = $current.Split(';') | Where-Object { $_ } }
    if ($parts -notcontains $Dir) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $Dir) -join ';'), 'User')
      Say "Added $Dir to your PATH (new terminals see the fai-browser command)."
    }
    if (($env:Path.Split(';')) -notcontains $Dir) { $env:Path = "$env:Path;$Dir" }
  }

  try {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This installer is for Windows. On Linux and macOS see the README.' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'FAI Browser needs 64-bit Windows.' }
    $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and $env:FAI_INSTALL_ALLOW_ADMIN -ne '1') {
      throw ("this PowerShell window runs as administrator. Open a normal PowerShell window (not 'Run as administrator') " +
        'and run the command there: FAI Browser installs for your user, and its local service must not run with administrator rights.')
    }
    $root = if ($env:FAI_INSTALL_ROOT) { $env:FAI_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'fai-browser' }
    New-Item -ItemType Directory -Force $root | Out-Null

    Step 'Node.js (private to FAI Browser)'
    $node = Install-Node $root

    Step 'FAI Browser'
    $source = Get-Source $root
    $previous = Get-ChildItem (Join-Path $root 'app') -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'src\cli.js') } | Sort-Object Name | Select-Object -Last 1
    if ($previous) {
      # Stop the service of the copy being replaced; the next client starts the new one.
      try { & $node (Join-Path $previous.FullName 'src\cli.js') daemon stop *> $null } catch { }
    }
    $sourceVersion = (Get-Content (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
    $app = Join-Path $root ("app\$sourceVersion-" + (Get-Date -Format 'yyyyMMddHHmmss'))
    New-Item -ItemType Directory -Force (Split-Path $app) | Out-Null
    Move-Item $source $app
    Set-Content -Path (Join-Path $app '.fai-install') -Value 'windows-installer' -Encoding ASCII
    $version = (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
    Say "FAI Browser $version is in $app."
    Copy-Item (Join-Path $app 'scripts\uninstall.ps1') (Join-Path $root 'uninstall.ps1') -Force
    $staleApps = Get-ChildItem (Join-Path $root 'app') -Directory | Where-Object { $_.FullName -ne $app }

    # Older private Node.js versions (best effort: files of one still running stay until the next run).
    Get-ChildItem (Join-Path $root 'node') -Directory | Where-Object { $_.FullName -ne (Split-Path $node) } | ForEach-Object {
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }

    Step 'The fai-browser command and the Start menu entry'
    $bin = Join-Path $root 'bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    $cli = Join-Path $app 'src\cli.js'
    Set-Content -Path (Join-Path $bin 'fai-browser.cmd') -Encoding ASCII -Value "@echo off`r`n`"$node`" `"$cli`" %*"
    Add-UserPath $bin
    $ico = Join-Path $root 'fai-browser.ico'
    Write-Icon (Join-Path $app 'extension\icons\icon-128.png') $ico
    $programs = [Environment]::GetFolderPath('Programs')
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $programs 'FAI Browser.lnk'))
    $link.TargetPath = $node
    $link.Arguments = "`"$cli`" launch --from-desktop --no-wait"
    $link.WorkingDirectory = $app
    $link.WindowStyle = 7
    $link.IconLocation = "$ico,0"
    $link.Description = 'Firefox with the FAI profile your coding agent works in'
    $link.Save()
    Say 'Start menu: FAI Browser'

    if ($env:FAI_INSTALL_NO_SETUP -eq '1') {
      Step 'Done (files only: FAI_INSTALL_NO_SETUP=1)'
      Say "Finish with: fai-browser launch --download"
      return
    }

    Step 'Setup: pairing, coding agents and FAI Browser (Firefox)'
    # Setup points the pairing helper and the coding agents at this copy; after it, older copies can go.
    Push-Location $app
    try {
      & $node (Join-Path $app 'scripts\setup.mjs') --yes --download-firefox
      $code = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($code -ne 0) { throw "Setup did not finish (exit $code). Fix what it says above, then run this installer again." }
    # The service may still run an older copy (a pairing helper can restart it while this runs): restart it on this one.
    & $node (Join-Path $app 'src\cli.js') daemon restart *> $null
    # An older copy goes once no process runs from it (an agent's MCP server keeps its copy until the agent restarts).
    $running = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { $_.CommandLine })
    foreach ($stale in $staleApps) {
      $used = $running | Where-Object { $_.IndexOf($stale.FullName, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
      if (-not $used) { Remove-Item $stale.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Step "FAI Browser $version is installed"
    Say 'Open it any time from the Start menu (FAI Browser).'
    Say 'Restart your coding agent (Claude Code, Codex, OpenCode) so it loads FAI Browser, then ask it to work in your browser.'
    Say 'Update: run the same install command again.'
    Say "Remove: powershell -ExecutionPolicy Bypass -File `"$root\uninstall.ps1`""
  } catch {
    Write-Host ''
    Write-Host "FAI Browser install failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Run the command again to retry. Details: https://github.com/jedbjorn/fai-browser/blob/main/docs/guide/troubleshooting.md'
  }
}
