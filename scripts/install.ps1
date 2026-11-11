<#
FAI Browser bootstrap installer for Windows 10 and 11 (Windows PowerShell 5.1 or PowerShell 7).

It checks for git and Node.js 22 or newer, says what is present and what is missing, installs a missing one only
after you say yes, clones FAI Browser at its latest release tag (or reuses your checkout) and runs the one-time
setup (`npm run setup`). Read it before you run it. From a normal (not "Run as administrator") PowerShell window:

  Invoke-WebRequest -UseBasicParsing -OutFile install-fai.ps1 https://raw.githubusercontent.com/jedbjorn/fai-browser/<tag>/scripts/install.ps1
  notepad install-fai.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-fai.ps1

(-ExecutionPolicy Bypass applies to that one powershell process only; it changes no setting.)

Where missing tools come from: winget, Windows' own package manager (App Installer), with the packages Git.Git and
OpenJS.NodeJS.LTS from the winget community source. Their installers may show Windows' permission prompt (UAC):
that is Windows asking you, never a silent elevation. Without winget the installer says where to get each tool and
stops. Nothing is piped into a shell, and every download is https.

Options:
  -Yes        answer yes to every question (unattended); also passed to setup (registers every coding agent found)
  -Check      check only: report what is present and what would be done, change nothing
  -Dir DIR    where the checkout goes (default: $env:FAI_INSTALL_DIR, else %USERPROFILE%\fai-browser)
  -Tag vX.Y.Z install this release instead of the latest
  -NoSetup    stop after the checkout; run `npm run setup` yourself later
  -AllowAdministrator
              run even from an elevated (administrator) window. Only for throwaway machines and CI: FAI Browser's
              local service would then run with administrator rights.
  -SetupArgs  arguments for setup (for example: -SetupArgs --no-firefox)
  -Help       this text
The installer never reads or prints the pairing secret; setup writes it to your settings directory itself.
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Check,
  [string]$Dir = '',
  [string]$Tag = '',
  [switch]$NoSetup,
  [switch]$AllowAdministrator,
  [string[]]$SetupArgs = @(),
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/jedbjorn/fai-browser.git'
$ApiLatest = 'https://api.github.com/repos/jedbjorn/fai-browser/releases/latest'
$NodeMin = 22
$TagPattern = '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'

function Say([string]$Text) { Write-Host $Text }

# Native commands run with ErrorActionPreference Continue: Windows PowerShell 5.1 turns a native program's stderr
# into error records when its output is redirected, which 'Stop' would make fatal. Their exit code decides.
# -Capture returns the program's stdout lines (stderr dropped); otherwise the output goes to the console.
function Invoke-Native {
  param([Parameter(Mandatory = $true)][string]$File, [string[]]$Arguments = @(), [switch]$Capture)
  $ErrorActionPreference = 'Continue'
  $global:LASTEXITCODE = 0
  if ($Capture) {
    $out = @(& $File @Arguments 2>$null | ForEach-Object { [string]$_ })
    return [pscustomobject]@{ Code = $global:LASTEXITCODE; Out = $out }
  }
  & $File @Arguments | Out-Host
  return [pscustomobject]@{ Code = $global:LASTEXITCODE; Out = @() }
}

function Stop-Install([string]$Text) {
  Write-Host ''
  Write-Host "FAI Browser install stopped: $Text" -ForegroundColor Red
  exit 1
}

if ($Help) {
  $text = Get-Content -LiteralPath $PSCommandPath -Raw
  $start = $text.IndexOf('<#') + 2
  $end = $text.IndexOf('#>')
  Write-Host $text.Substring($start, $end - $start).Trim()
  exit 0
}

if ($Tag -and $Tag -notmatch $TagPattern) { Stop-Install "-Tag must be a release tag such as v0.8.0, not '$Tag'" }

# Windows PowerShell 5.1 may still default to TLS 1.0; GitHub and nodejs.org need 1.2.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $AllowAdministrator) {
  Stop-Install ("this window runs as administrator. Open a normal PowerShell window (not 'Run as administrator') and " +
    "run the installer there: FAI Browser installs for your user, and winget asks Windows for permission itself " +
    "when an installer needs it.")
}

if (-not $Dir) { $Dir = $env:FAI_INSTALL_DIR }
if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE 'fai-browser' }
# Relative to this PowerShell location (not the process directory, which Set-Location does not move).
$Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)

function Confirm-Step([string]$Question) {
  if ($Yes) {
    Say "$Question [Y/n] yes (-Yes)"
    return $true
  }
  if ([Console]::IsInputRedirected) {
    Stop-Install "$Question needs an answer, but there is no console to ask in. Run it in a PowerShell window, or pass -Yes."
  }
  $answer = Read-Host "$Question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes)$')
}

# Refresh PATH from the registry, so a tool winget just installed is found without a new window.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# ---------------------------------------------------------------------------------------------------------------
# What is installed
# ---------------------------------------------------------------------------------------------------------------

function Get-GitState {
  $command = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { return @{ Ok = $false; Note = 'not found' } }
  $run = Invoke-Native $command.Source @('--version') -Capture
  $version = [string](@($run.Out | Where-Object { $_ }) | Select-Object -First 1)
  if ($run.Code -ne 0 -or -not $version) { return @{ Ok = $false; Note = "$($command.Source) does not run" } }
  return @{ Ok = $true; Note = "$version ($($command.Source))"; Path = $command.Source }
}

function Get-NodeState {
  $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { return @{ Ok = $false; Note = 'not found' } }
  $run = Invoke-Native $command.Source @('-p', 'process.versions.node') -Capture
  $version = [string](@($run.Out) | Select-Object -First 1)
  if ($run.Code -ne 0 -or -not ($version -match '^(\d+)\.')) { return @{ Ok = $false; Note = "$($command.Source) does not run" } }
  if ([int]$Matches[1] -lt $NodeMin) {
    return @{ Ok = $false; Note = "v$version is too old ($($command.Source); FAI Browser needs $NodeMin or newer)" }
  }
  return @{ Ok = $true; Note = "v$version ($($command.Source))"; Path = $command.Source }
}

# An existing directory: 'ours' (a clone of github.com/jedbjorn/fai-browser), 'other', or 'none' (absent or empty).
function Get-CheckoutState([bool]$GitOk) {
  if (-not (Test-Path -LiteralPath $Dir)) { return 'none' }
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return 'other' }
  if (-not (Get-ChildItem -LiteralPath $Dir -Force | Select-Object -First 1)) { return 'none' }
  $package = Join-Path $Dir 'package.json'
  $isOurs = (Test-Path -LiteralPath (Join-Path $Dir '.git')) -and (Test-Path -LiteralPath (Join-Path $Dir 'scripts\setup.mjs')) -and
    (Test-Path -LiteralPath $package) -and ((Get-Content -LiteralPath $package -Raw) -match '"name":\s*"fai-browser"')
  if (-not $isOurs) { return 'other' }
  # Without git yet, the remote is checked once git is installed (this runs again before the clone).
  if (-not $GitOk) { return 'ours' }
  $url = [string](@((Invoke-Native 'git' @('-C', $Dir, 'remote', 'get-url', 'origin') -Capture).Out) | Select-Object -First 1)
  if ($url -match '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)jedbjorn/fai-browser(\.git)?/?$') { return 'ours' }
  return 'other'
}

$git = Get-GitState
$node = Get-NodeState
$winget = Get-Command winget -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$checkout = Get-CheckoutState $git.Ok

$os = [Environment]::OSVersion.VersionString
$arch = $env:PROCESSOR_ARCHITECTURE
Say 'FAI Browser installer'
Say "  system:  $os $arch, PowerShell $($PSVersionTable.PSVersion)"
Say "  git:     $($git.Note)"
Say "  Node.js: $($node.Note)"
if ($winget) { Say "  winget:  $($winget.Source)" } else { Say '  winget:  not found' }
switch ($checkout) {
  'ours' { Say "  FAI Browser: a checkout already at $Dir (reused)" }
  'other' { Say "  FAI Browser: $Dir exists and is not a FAI Browser checkout" }
  default { Say "  FAI Browser: not at $Dir yet" }
}
Say ''

# ---------------------------------------------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------------------------------------------

$script:step = 0
function Plan([string]$Text) {
  $script:step += 1
  Say "  $($script:step). $Text"
}
Say 'Plan:'
$missing = @()
if (-not $git.Ok) { $missing += 'git' }
if (-not $node.Ok) { $missing += 'Node.js' }
if ($missing.Count -and -not $winget) {
  Plan ("Stop: $($missing -join ' and ') missing and winget is not installed. Install App Installer from the " +
    'Microsoft Store (it provides winget), or install the tools yourself (listed below), then run this again.')
} else {
  if (-not $git.Ok) { Plan 'Install git with winget (winget install --id Git.Git; Windows may ask for permission).' }
  if (-not $node.Ok) { Plan 'Install Node.js LTS with winget (winget install --id OpenJS.NodeJS.LTS; Windows may ask for permission).' }
}
switch ($checkout) {
  'ours' { Plan "Reuse the checkout at $Dir (to update it later: node src\cli.js update)." }
  'other' { Plan "Stop: $Dir is taken. Pass -Dir to choose another directory." }
  default {
    if ($Tag) { Plan "Clone FAI Browser $Tag into $Dir." } else { Plan "Clone FAI Browser at its latest release tag into $Dir." }
  }
}
if ($NoSetup) { Plan 'Skip the setup (-NoSetup).' }
else { Plan 'Run the one-time setup (npm run setup): pairing secret, browser pairing, the local service, coding agents.' }
Say ''

if ($Check) {
  Say 'Check only (-Check): nothing was changed.'
  exit 0
}

if ($checkout -eq 'other') { Stop-Install "$Dir exists and is not a FAI Browser checkout. Choose another directory with -Dir." }

# ---------------------------------------------------------------------------------------------------------------
# Installing what is missing
# ---------------------------------------------------------------------------------------------------------------

if ($missing.Count -and -not $winget) {
  Say 'Install them yourself, then run this installer again:'
  if (-not $git.Ok) { Say '  git:     https://git-scm.com/download/win' }
  if (-not $node.Ok) { Say "  Node.js: https://nodejs.org/en/download ($NodeMin or newer; the LTS version)" }
  Stop-Install 'winget is not installed (App Installer from the Microsoft Store provides it).'
}

function Install-WithWinget([string]$Id, [string]$Name) {
  if (-not (Confirm-Step "Install $Name with winget ($Id)?")) {
    Stop-Install "$Name is needed. Install it, then run this again."
  }
  Say "winget install --id $Id --exact --source winget"
  # The agreements are accepted here because you just said yes; winget would otherwise stop and ask again.
  $run = Invoke-Native $winget.Source @('install', '--id', $Id, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements')
  # -1978335189 (0x8A15002B): already installed, no newer version. Anything else non-zero is a failure.
  if ($run.Code -ne 0 -and $run.Code -ne -1978335189) {
    Stop-Install "winget could not install $Name (exit $($run.Code); see above)."
  }
  Update-SessionPath
}

if (-not $git.Ok) {
  Install-WithWinget 'Git.Git' 'git'
  $git = Get-GitState
  if (-not $git.Ok) { Stop-Install 'git is installed but not found in this window. Open a new PowerShell window and run this again.' }
  Say "git ready: $($git.Note)"
}
if (-not $node.Ok) {
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  $node = Get-NodeState
  if (-not $node.Ok) { Stop-Install "Node.js is not usable in this window ($($node.Note)). Open a new PowerShell window and run this again." }
  Say "Node.js ready: $($node.Note)"
}

# ---------------------------------------------------------------------------------------------------------------
# The checkout
# ---------------------------------------------------------------------------------------------------------------

function Get-LatestTag {
  $found = ''
  try {
    $release = Invoke-RestMethod -Uri $ApiLatest -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 30 -ErrorAction Stop
    $found = [string]$release.tag_name
  } catch { }
  if ($found -notmatch $TagPattern) {
    # No API answer (rate limit, proxy): the highest vX.Y.Z tag on the repository.
    $found = ''
    $refs = (Invoke-Native $git.Path @('ls-remote', '--tags', '--refs', $RepoUrl, 'v*') -Capture).Out
    $best = $null
    foreach ($line in $refs) {
      if ([string]$line -match 'refs/tags/(v(\d+)\.(\d+)\.(\d+))$') {
        $version = [version]::new([int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
        if (-not $best -or $version -gt $best.Version) { $best = @{ Tag = $Matches[1]; Version = $version } }
      }
    }
    if ($best) { $found = $best.Tag }
  }
  if ($found -notmatch $TagPattern) {
    Stop-Install 'could not find the latest release of FAI Browser (network?). Pass -Tag vX.Y.Z to choose one.'
  }
  return $found
}

$checkout = Get-CheckoutState $true
if ($checkout -eq 'other') { Stop-Install "$Dir exists and is not a clone of github.com/jedbjorn/fai-browser. Choose another directory with -Dir." }
if ($checkout -eq 'none') {
  if (-not $Tag) { $Tag = Get-LatestTag }
  Say "Cloning FAI Browser $Tag into $Dir"
  $parent = Split-Path -Parent $Dir
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null }
  # LF line endings in the checkout, whatever core.autocrlf says: the files stay byte-identical to the release.
  $run = Invoke-Native $git.Path @('-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-checkout', $RepoUrl, $Dir)
  if ($run.Code -ne 0) { Stop-Install 'git clone failed (see above). Nothing else was changed; run this again.' }
  $null = Invoke-Native $git.Path @('-C', $Dir, 'config', 'core.autocrlf', 'false')
  $run = Invoke-Native $git.Path @('-C', $Dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', "refs/tags/$Tag")
  if ($run.Code -ne 0) { Stop-Install "release $Tag is not in the repository (see above). Remove $Dir and run this again." }
} else {
  $described = [string](@((Invoke-Native $git.Path @('-C', $Dir, 'describe', '--tags', '--always') -Capture).Out) | Select-Object -First 1)
  Say "Using the existing checkout at $Dir ($described)."
  if ($Tag) { Say '  It is left as it is (-Tag applies to a new clone); node src\cli.js update moves it to the latest release.' }
}

# FAI Browser has no runtime npm dependencies: node_modules holds only development tools (tests), so setup needs no
# npm ci. Setup runs as `node scripts\setup.mjs` (what `npm run setup` runs), which also works where PowerShell's
# execution policy blocks npm.ps1.

if ($NoSetup) {
  Say ''
  Say "Done (-NoSetup). Next: cd `"$Dir`"; npm run setup"
  exit 0
}

if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
  Say ''
  Say 'The checkout is ready. Setup must run in a console window (it asks before it registers your coding agents):'
  Say "  cd `"$Dir`"; npm run setup"
  exit 0
}

Say ''
Say 'Running the one-time setup (npm run setup) ...'
Say ''
$setupArgv = @((Join-Path $Dir 'scripts\setup.mjs'))
if ($Yes) { $setupArgv += '--yes' }
$setupArgv += $SetupArgs
# Called directly (not through Invoke-Native): setup needs this console as its terminal to ask its questions.
Push-Location -LiteralPath $Dir
$ErrorActionPreference = 'Continue'
try {
  $global:LASTEXITCODE = 0
  & $node.Path @setupArgv
  $setupExit = $global:LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
}
if ($setupExit -ne 0) { Stop-Install "setup failed (see above). Fix the cause and run: cd `"$Dir`"; npm run setup" }

Say ''
Say "FAI Browser is installed in $Dir."
Say '  Load the extension, pin its icon and restart your coding agent as listed above.'
Say "  Update later: cd `"$Dir`"; node src\cli.js update (or the Update button in the extension popup)."
Say '  Install again or repair: run this installer again; it reuses the checkout.'
