#!/bin/sh
# FAI Browser bootstrap installer for macOS (Apple silicon and Intel) and Linux. POSIX sh: runs in macOS's
# /bin/sh (bash 3.2), dash and bash.
#
# It checks for git and Node.js 22 or newer, says what is present and what is missing, installs a missing one only
# after you say yes, clones FAI Browser at its latest release tag (or reuses your checkout) and runs the one-time
# setup (`npm run setup`). Read it before you run it:
#
#   curl -fsSLo install-fai.sh https://raw.githubusercontent.com/jedbjorn/fai-browser/<tag>/scripts/install.sh
#   less install-fai.sh
#   sh install-fai.sh
#
# Where missing tools come from (never a script piped into a shell, https only):
#   macOS git:   the Xcode Command Line Tools (`xcode-select --install`: Apple's own dialog; you click Install).
#   macOS Node:  Homebrew (`brew install node`) when Homebrew is already installed; otherwise the official installer
#                package from nodejs.org, checked against nodejs.org's SHASUMS256.txt before it runs. The package
#                installer needs administrator rights: `sudo` asks for your password and says why first.
#                Homebrew itself is never installed for you.
#   Linux:       nothing is installed for you (your distribution's package manager needs root); the installer prints
#                the command to run.
#
# Options:
#   --yes          answer yes to every question (unattended); also passed to setup (registers every coding agent found)
#   --check        check only: report what is present and what would be done, change nothing
#   --dir DIR      where the checkout goes (default: $FAI_INSTALL_DIR, else ~/fai-browser)
#   --tag vX.Y.Z   install this release instead of the latest
#   --no-setup     stop after the checkout; run `npm run setup` yourself later
#   --help         this text
# The installer never reads or prints the pairing secret; setup writes it to your settings directory itself.

set -eu

REPO_URL='https://github.com/jedbjorn/fai-browser.git'
API_LATEST='https://api.github.com/repos/jedbjorn/fai-browser/releases/latest'
NODE_MIN=22
# The Node.js release line installed from nodejs.org when Node is missing (an LTS line CI tests on).
NODE_LINE="${FAI_NODE_LINE:-24}"
NODE_DIST="https://nodejs.org/dist/latest-v${NODE_LINE}.x"

YES=0
CHECK=0
SETUP=1
TAG=''
DIR="${FAI_INSTALL_DIR:-}"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  warn ''
  warn "FAI Browser install stopped: $*"
  exit 1
}

usage() {
  sed -n '2,/^# The installer never/p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --check|--dry-run) CHECK=1 ;;
    --no-setup) SETUP=0 ;;
    --dir) [ $# -ge 2 ] || die '--dir needs a directory'; DIR="$2"; shift ;;
    --dir=*) DIR="${1#--dir=}" ;;
    --tag) [ $# -ge 2 ] || die '--tag needs a release tag such as v0.8.0'; TAG="$2"; shift ;;
    --tag=*) TAG="${1#--tag=}" ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

valid_tag() {
  printf '%s' "$1" | grep -Eq '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
}

if [ -n "$TAG" ] && ! valid_tag "$TAG"; then
  die "--tag must be a release tag such as v0.8.0, not '$TAG'"
fi

if [ "$(id -u)" = 0 ]; then
  die 'do not run this as root (or with sudo). Run it as yourself: FAI Browser installs into your home directory, and
  the one step that needs administrator rights (the Node.js package on macOS) asks for your password itself.'
fi

[ -n "${HOME:-}" ] || die 'HOME is not set'
[ -n "$DIR" ] || DIR="$HOME/fai-browser"
case "$DIR" in
  /*) ;;
  *) DIR="$(pwd)/${DIR#./}" ;;
esac

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
  *) die "this installer is for macOS and Linux; on Windows use scripts/install.ps1 (found $OS)" ;;
esac

# Ask a yes/no question; --yes answers yes, --check never gets here. Default yes on Enter.
confirm() {
  if [ "$YES" = 1 ]; then
    say "$1 [Y/n] yes (--yes)"
    return 0
  fi
  if [ ! -t 0 ]; then
    die "$1 needs an answer, but there is no terminal to ask in. Run it in a terminal, or pass --yes."
  fi
  printf '%s [Y/n] ' "$1"
  read -r answer || answer=n
  case "$answer" in
    ''|y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------
# What is installed
# ---------------------------------------------------------------------------------------------------------------

GIT_OK=0
GIT_NOTE=''
detect_git() {
  GIT_OK=0
  GIT_NOTE=''
  git_path="$(command -v git 2>/dev/null || true)"
  if [ -z "$git_path" ]; then
    GIT_NOTE='not found'
    return 0
  fi
  # On macOS /usr/bin/git is a stub until the Command Line Tools are installed: running it opens Apple's dialog.
  if [ "$PLATFORM" = macos ] && [ "$git_path" = /usr/bin/git ] && ! xcode-select -p >/dev/null 2>&1; then
    GIT_NOTE='not installed (only the Command Line Tools stub at /usr/bin/git)'
    return 0
  fi
  if git_version="$(git --version 2>/dev/null)"; then
    GIT_OK=1
    GIT_NOTE="$git_version ($git_path)"
  else
    GIT_NOTE="$git_path does not run"
  fi
}

NODE_OK=0
NODE_NOTE=''
detect_node() {
  NODE_OK=0
  NODE_NOTE=''
  node_path="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_path" ]; then
    NODE_NOTE='not found'
    return 0
  fi
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  node_major="${node_version%%.*}"
  case "$node_major" in
    ''|*[!0-9]*) NODE_NOTE="$node_path does not run"; return 0 ;;
  esac
  if [ "$node_major" -ge "$NODE_MIN" ]; then
    NODE_OK=1
    NODE_NOTE="v$node_version ($node_path)"
  else
    NODE_NOTE="v$node_version is too old ($node_path; FAI Browser needs $NODE_MIN or newer)"
  fi
}

BREW=''
detect_brew() {
  BREW="$(command -v brew 2>/dev/null || true)"
  if [ -z "$BREW" ]; then
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [ -x "$candidate" ]; then BREW="$candidate"; break; fi
    done
  fi
}

# An existing checkout at DIR: 'ours' (a clone of github.com/jedbjorn/fai-browser), 'other' (something else),
# 'none' (no such directory, or an empty one).
CHECKOUT=none
detect_checkout() {
  CHECKOUT=none
  if [ ! -e "$DIR" ]; then return 0; fi
  [ -d "$DIR" ] || { CHECKOUT=other; return 0; }
  if [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then return 0; fi
  if [ -d "$DIR/.git" ] && [ -f "$DIR/scripts/setup.mjs" ] && grep -q '"name": "fai-browser"' "$DIR/package.json" 2>/dev/null; then
    # Without git yet, the remote is checked once git is installed (this runs again before the clone).
    [ "$GIT_OK" = 1 ] || { CHECKOUT=ours; return 0; }
    url="$(git -C "$DIR" remote get-url origin 2>/dev/null || true)"
    if printf '%s' "$url" | grep -Eiq '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)jedbjorn/fai-browser(\.git)?/?$'; then
      CHECKOUT=ours
      return 0
    fi
  fi
  CHECKOUT=other
}

detect_git
detect_node
[ "$PLATFORM" = macos ] && detect_brew
detect_checkout

say 'FAI Browser installer'
say "  system:  $OS $ARCH"
say "  git:     $GIT_NOTE"
say "  Node.js: $NODE_NOTE"
[ "$PLATFORM" = macos ] && say "  Homebrew: ${BREW:-not installed (fine: it is not needed)}"
case "$CHECKOUT" in
  ours) say "  FAI Browser: a checkout already at $DIR (reused)" ;;
  other) say "  FAI Browser: $DIR exists and is not a FAI Browser checkout" ;;
  none) say "  FAI Browser: not at $DIR yet" ;;
esac
say ''

# ---------------------------------------------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------------------------------------------

say 'Plan:'
step=0
plan() {
  step=$((step + 1))
  say "  $step. $*"
}
if [ "$GIT_OK" = 0 ]; then
  if [ "$PLATFORM" = macos ]; then
    plan "Install git with Apple's Command Line Tools (xcode-select --install opens Apple's dialog; you click Install)."
  else
    plan 'Install git with your package manager (printed below; needs root, so you run it yourself).'
  fi
fi
if [ "$NODE_OK" = 0 ]; then
  if [ "$PLATFORM" = macos ] && [ -n "$BREW" ]; then
    plan "Install Node.js with Homebrew (brew install node)."
  elif [ "$PLATFORM" = macos ]; then
    plan "Install Node.js $NODE_LINE LTS from the official nodejs.org package, checked against its SHASUMS256.txt (sudo installer asks for your password)."
  else
    plan "Install Node.js $NODE_MIN or newer yourself (printed below)."
  fi
fi
case "$CHECKOUT" in
  ours) plan "Reuse the checkout at $DIR (to update it later: node src/cli.js update)." ;;
  none) plan "Clone FAI Browser ${TAG:-at its latest release tag} into $DIR." ;;
  other) plan "Stop: $DIR is taken. Pass --dir to choose another directory." ;;
esac
if [ "$SETUP" = 1 ]; then
  plan 'Run the one-time setup (npm run setup): pairing secret, browser pairing, the local service, coding agents.'
else
  plan 'Skip the setup (--no-setup).'
fi
say ''

if [ "$CHECK" = 1 ]; then
  say 'Check only (--check): nothing was changed.'
  exit 0
fi

[ "$CHECKOUT" = other ] && die "$DIR exists and is not a FAI Browser checkout. Choose another directory with --dir."

# ---------------------------------------------------------------------------------------------------------------
# Installing what is missing
# ---------------------------------------------------------------------------------------------------------------

linux_hint() {
  if command -v apt-get >/dev/null 2>&1; then say "    sudo apt-get install $1"
  elif command -v dnf >/dev/null 2>&1; then say "    sudo dnf install $1"
  elif command -v pacman >/dev/null 2>&1; then say "    sudo pacman -S $1"
  elif command -v zypper >/dev/null 2>&1; then say "    sudo zypper install $1"
  else say "    (your distribution's package manager) $1"
  fi
}

install_git_macos() {
  confirm 'Install git (Apple Command Line Tools)?' || die 'git is needed. Install it, then run this again.'
  # Starts Apple's installer dialog and returns at once; it fails when an install is already running or done.
  xcode-select --install >/dev/null 2>&1 || true
  say 'Apple'"'"'s dialog asks to install the Command Line Tools: click Install and accept the licence there.'
  say 'It downloads from Apple and can take several minutes. This installer waits for it.'
  waited=0
  while ! xcode-select -p >/dev/null 2>&1; do
    if [ "$YES" = 1 ] || [ ! -t 0 ]; then
      [ "$waited" -lt 3600 ] || die 'the Command Line Tools did not finish within an hour. Run this again when they have.'
      sleep 10
      waited=$((waited + 10))
    else
      printf 'Press Enter when the Command Line Tools installation has finished (Ctrl-C to stop): '
      read -r _ || die 'stopped'
    fi
  done
  detect_git
  [ "$GIT_OK" = 1 ] || die "git still does not run after the Command Line Tools install ($GIT_NOTE)."
  say "git ready: $GIT_NOTE"
}

install_node_brew() {
  confirm 'Install Node.js with Homebrew (brew install node)?' || die "Node.js $NODE_MIN or newer is needed. Install it, then run this again."
  "$BREW" install node || die 'brew install node failed (see its output above).'
}

install_node_pkg() {
  confirm "Install Node.js $NODE_LINE LTS from nodejs.org (the official .pkg; needs your password)?" \
    || die "Node.js $NODE_MIN or newer is needed. Install it, then run this again."
  command -v curl >/dev/null 2>&1 || die 'curl is missing (it ships with macOS).'
  command -v shasum >/dev/null 2>&1 || die 'shasum is missing (it ships with macOS).'
  work="$(mktemp -d "${TMPDIR:-/tmp}/fai-node.XXXXXX")" || die 'could not create a temporary directory'
  trap 'rm -rf "$work"' EXIT
  say "Downloading $NODE_DIST/SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$work/SHASUMS256.txt" "$NODE_DIST/SHASUMS256.txt" \
    || die "could not download $NODE_DIST/SHASUMS256.txt"
  # The macOS package is universal (Apple silicon and Intel): node-vX.Y.Z.pkg.
  pkg_line="$(grep -E "^[0-9a-f]{64}  node-v${NODE_LINE}\.[0-9]+\.[0-9]+\.pkg\$" "$work/SHASUMS256.txt" | head -n 1 || true)"
  [ -n "$pkg_line" ] || die "no node-v${NODE_LINE}.x .pkg listed in $NODE_DIST/SHASUMS256.txt"
  pkg_sum="${pkg_line%% *}"
  pkg_name="${pkg_line##* }"
  say "Downloading $NODE_DIST/$pkg_name"
  curl --proto '=https' --tlsv1.2 -fSL -o "$work/$pkg_name" "$NODE_DIST/$pkg_name" || die "could not download $pkg_name"
  got_sum="$(shasum -a 256 "$work/$pkg_name" | cut -d ' ' -f 1)"
  [ "$got_sum" = "$pkg_sum" ] || die "$pkg_name does not match its SHA-256 in SHASUMS256.txt (got $got_sum); nothing was installed."
  say "Checksum OK ($pkg_sum)."
  say 'The Node.js installer writes to /usr/local, so it needs administrator rights: sudo asks for your password now.'
  sudo /usr/sbin/installer -pkg "$work/$pkg_name" -target / || die 'the Node.js installer failed (see its output above).'
  rm -rf "$work"
  trap - EXIT
}

if [ "$GIT_OK" = 0 ]; then
  if [ "$PLATFORM" = macos ]; then
    install_git_macos
  else
    say 'git is missing. Install it with your package manager, then run this again:'
    linux_hint git
    exit 1
  fi
fi

if [ "$NODE_OK" = 0 ]; then
  if [ "$PLATFORM" = macos ]; then
    if [ -n "$BREW" ]; then install_node_brew; else install_node_pkg; fi
    # The package installs into /usr/local/bin, which may not be on this shell's PATH yet.
    case ":$PATH:" in *:/usr/local/bin:*) ;; *) PATH="/usr/local/bin:$PATH"; export PATH ;; esac
    if [ -n "$BREW" ]; then
      brew_prefix="$("$BREW" --prefix 2>/dev/null || true)"
      [ -n "$brew_prefix" ] && case ":$PATH:" in *:"$brew_prefix/bin":*) ;; *) PATH="$brew_prefix/bin:$PATH"; export PATH ;; esac
    fi
    detect_node
    [ "$NODE_OK" = 1 ] || die "Node.js is still not usable ($NODE_NOTE). Open a new terminal and run this again."
    say "Node.js ready: $NODE_NOTE"
  else
    say "Node.js $NODE_MIN or newer is missing ($NODE_NOTE). Install it from https://nodejs.org/en/download or your"
    say 'package manager, then run this again. For example:'
    linux_hint nodejs
    exit 1
  fi
fi

# ---------------------------------------------------------------------------------------------------------------
# The checkout
# ---------------------------------------------------------------------------------------------------------------

latest_tag() {
  found=''
  if command -v curl >/dev/null 2>&1; then
    found="$(curl --proto '=https' --tlsv1.2 -fsSL -H 'Accept: application/vnd.github+json' "$API_LATEST" 2>/dev/null \
      | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*$/\1/p' | head -n 1 || true)"
  fi
  if ! valid_tag "$found"; then
    # No API answer (rate limit, proxy): the highest vX.Y.Z tag on the repository.
    found="$(git ls-remote --tags --refs "$REPO_URL" 'v*' 2>/dev/null | sed -n 's|.*refs/tags/||p' \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 || true)"
  fi
  valid_tag "$found" || die "could not find the latest release of FAI Browser (network?). Pass --tag vX.Y.Z to choose one."
  printf '%s' "$found"
}

detect_checkout
[ "$CHECKOUT" = other ] && die "$DIR exists and is not a clone of github.com/jedbjorn/fai-browser. Choose another directory with --dir."
if [ "$CHECKOUT" = none ]; then
  [ -n "$TAG" ] || TAG="$(latest_tag)"
  say "Cloning FAI Browser $TAG into $DIR"
  mkdir -p "$(dirname "$DIR")"
  # A detached checkout of the release tag: the built-in updater (node src/cli.js update) moves it to later releases.
  git clone --quiet --no-checkout "$REPO_URL" "$DIR" \
    || die "git clone failed (see above). Nothing else was changed; run this again."
  git -C "$DIR" -c advice.detachedHead=false checkout --quiet "refs/tags/$TAG" \
    || die "release $TAG is not in the repository (see above). Remove $DIR and run this again."
else
  say "Using the existing checkout at $DIR ($(git -C "$DIR" describe --tags --always 2>/dev/null || echo unknown))."
  if [ -n "$TAG" ]; then
    say "  It is left as it is (--tag applies to a new clone); node src/cli.js update moves it to the latest release."
  fi
fi

cd "$DIR"

# FAI Browser has no runtime npm dependencies: node_modules holds only development tools (tests), so setup needs no
# npm ci. Developers run npm ci themselves (CONTRIBUTING.md).

if [ "$SETUP" = 0 ]; then
  say ''
  say "Done (--no-setup). Next: cd \"$DIR\" && npm run setup"
  exit 0
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  say ''
  say 'The checkout is ready. Setup must run in a terminal (it asks before it registers your coding agents):'
  say "  cd \"$DIR\" && npm run setup"
  exit 0
fi

say ''
say 'Running the one-time setup (npm run setup) ...'
say ''
if [ "$YES" = 1 ]; then
  node scripts/setup.mjs --yes || die "setup failed (see above). Fix the cause and run: cd \"$DIR\" && npm run setup"
else
  node scripts/setup.mjs || die "setup failed (see above). Fix the cause and run: cd \"$DIR\" && npm run setup"
fi

say ''
say "FAI Browser is installed in $DIR."
say '  Load the extension, pin its icon and restart your coding agent as listed above.'
say "  Update later: cd \"$DIR\" && node src/cli.js update (or the Update button in the extension popup)."
say '  Install again or repair: run this installer again; it reuses the checkout.'
