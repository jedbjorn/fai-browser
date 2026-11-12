# Install

FAI Browser is distributed for **Firefox**. There are two ways to get it, plus a from-source path for Chromium-family
browsers:

| | What you get | For |
|---|---|---|
| **1. Download FAI Browser** (recommended) | Official Firefox with a separate **FAI** profile, the signed add-on preinstalled and paired | Most people: the agent never sees your everyday browsing |
| **2. Add to your Firefox** | The signed add-on in a Firefox profile you already use | You want the agent in a profile you already have |
| Chromium, from source | `extension/` loaded unpacked in Chrome, Brave, Edge, Vivaldi | Developers |

All three need the local part (the FAI service and the MCP server) from this repository, Node 22 or newer, and Linux or
macOS. On Windows, [one command](#windows) installs path 1 with everything it needs.

```sh
git clone https://github.com/jedbjorn/fai-browser
cd fai-browser
```

No git or Node yet on macOS: `scripts/install.sh` checks for both, installs what is missing after you say yes, clones
the latest release and runs setup
([getting started](getting-started.md#1-install), [REFERENCE](../REFERENCE.md#bootstrap-installers)).

## 1. Download FAI Browser

"FAI Browser" is **not a separate browser and not a fork**. It is Mozilla's own, unmodified Firefox, started with a
dedicated profile that holds the FAI Browser add-on. Firefox updates itself from Mozilla as usual; FAI never changes or
redistributes Firefox.

```sh
npm run setup
```

Setup creates the pairing secret, starts the local service, offers to register your coding agents and ends with:

```text
Set up the FAI Browser profile for Firefox? [Y/n]
```

Press Enter. (Without an official Firefox installed, setup prints the launcher command instead.) You can also run the
launcher directly, any time:

```sh
node src/cli.js launch            # set up what is missing, then open FAI Browser
node src/cli.js launch --print    # dry run: what it would use, write and run; changes nothing
```

Once the package is on npm, `npx fai-browser launch` does the same (prefer `npm install -g fai-browser`, so the pairing
helper does not point into the npx cache).

### What the launcher does

1. **Finds an official Firefox 140+**: `--firefox <path>` or `FIREFOX_PATH`, the one it used last time, its own copy,
   then the system: on Linux `firefox`/`firefox-esr` on `PATH` (wrapper scripts are followed), `/usr/lib/firefox`,
   `/opt/firefox`; on macOS `Firefox.app` (also ESR, Developer Edition, Nightly) in `/Applications` or `~/Applications`;
   on Windows `Program Files\Mozilla Firefox`. Your distribution's Firefox package is fine.
2. **Snap and Flatpak Firefox are not used.** They run sandboxed and can start the pairing helper only through the
   WebExtensions portal, which many desktops lack, so the add-on could not pair. The launcher says so and offers the
   official build instead.
3. **No usable Firefox?** It asks first, then downloads the latest Firefox from `download.mozilla.org` into its data
   directory. The file must match Mozilla's `SHA512SUMS`; when `gpg` is installed, `SHA512SUMS` must also carry a valid
   signature by Mozilla's release key (`14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526 D98F 0353`), checked in a throwaway
   keyring. Without `gpg` it says the signature was not checked (`--require-signature` refuses instead). This copy
   updates itself from Mozilla.
4. **Pairs**: the pairing secret (as setup makes it), the native messaging host for Firefox, the local service.
5. **Installs the signed add-on** into the profile (below).
6. **Opens FAI Browser**: `firefox --profile <data>/profile --no-remote <welcome page>`, with a short local welcome page
   that shows the checks and explains approvals, levels and secret redaction. In a terminal it waits until the add-on
   reports **Connected to the FAI service**.
7. **On Linux, offers a menu entry** "FAI Browser" (`~/.local/share/applications/fai-browser.desktop`, with the add-on's
   icon). It declares no URL or file types, so it never becomes your default browser.

Where things go (nothing in `~/.mozilla` except the pairing helper's manifest):

| | Linux | macOS | Windows |
|---|---|---|---|
| Launcher data: `profile/`, `firefox/` (if downloaded), `addon/`, `welcome.html` | `~/.local/share/fai-browser` (`$XDG_DATA_HOME`) | `~/Library/Application Support/fai-browser/browser` | `%LOCALAPPDATA%\fai-browser\browser` |
| Pairing helper manifest | `~/.mozilla/native-messaging-hosts/fai_browser.json` | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` | `HKCU\Software\Mozilla\NativeMessagingHosts\fai_browser` |

### The FAI profile

- **Separate.** Its own bookmarks, history, cookies and sign-ins. Sign in there only to accounts the agent may use. It is
  started with `--profile <dir>` and never registered in Firefox's `profiles.ini`, so your profile manager and everyday
  profile are untouched.
- **`user.js`** (rewritten at each launch; change anything else in Settings or `about:config` as usual): no
  default-browser question, no first-run, what's-new or upgrade pages; telemetry, studies and sponsored content off;
  HTTPS-Only and Global Privacy Control on; **no saved passwords and no card autofill** in an agent profile;
  `extensions.autoDisableScopes = 14` so the add-on in the profile starts enabled without the "new add-on" prompt (other
  install locations stay auto-disabled). Signature checks stay on.
- **No remote control, ever.** No Marionette, no remote debugging, no remote-agent pref or flag. `--no-remote` also keeps
  links opened by other apps out of the agent profile. If FAI Browser is already open, the launcher says so instead of
  starting a second copy.
- **How the add-on is installed.** The signed `.xpi` is copied to `<profile>/extensions/fai-browser@jedbjorn.github.io.xpi`
  (a profile-scope install: no admin rights, nothing outside the profile). Release Firefox accepts it because Mozilla
  signed it; an unsigned file is refused. For the Firefox copy the launcher downloaded, it also writes
  `distribution/policies.json` with `ExtensionSettings` `force_installed`, so that copy, which only ever runs the FAI
  profile, keeps the add-on installed and enabled (Settings then shows "Your browser is being managed by your
  organization"; that refers to this policy). The launcher never writes a policy into a system Firefox: it would need
  admin rights and would affect every profile.
- **Updates.** Firefox updates itself. The add-on has an `update_url` (the latest GitHub Release's `updates.json`), so
  Firefox installs newer signed versions by itself; the launcher never replaces a newer add-on with an older one.

The add-on file comes from, in order: `--xpi <file>`, the copy a previous launch kept, `dist/` of this checkout (after
`npm run sign:firefox`), else the GitHub Release matching this package's version, checked against its `SHA256SUMS`.

### Options

| Option | Effect |
|---|---|
| `--print` (`--json`) | Dry run |
| `--firefox <path>` | Use this Firefox (refused if it is a Snap/Flatpak build or older than 140) |
| `--xpi <file>` | Install this signed add-on |
| `--download` | Agree to download Firefox from Mozilla without asking |
| `--lang ab-CD` | Language of a downloaded Firefox (default `en-US`) |
| `--require-signature` | Refuse a download when `gpg` cannot check Mozilla's signature |
| `--desktop` / `--no-desktop` | Write / skip the Linux menu entry without asking |
| `--no-welcome`, `--no-wait` | No welcome page; do not wait for the pairing |

### Shortcuts on macOS

The launcher writes a menu entry on Linux; the [Windows installer](#windows) adds a Start menu entry. On **macOS**, open
Script Editor, paste `do shell script "'/usr/local/bin/node' '/path/to/fai-browser/src/cli.js' launch --from-desktop"`
(your `which node` and checkout path), and save it as an Application named "FAI Browser".

### Remove it

```sh
node src/cli.js uninstall-launcher   # lists what it removes and asks; --yes to skip the question
```

It removes the launcher data directory (the FAI profile with its sign-ins and history, FAI's Firefox copy, the add-on
file) and the menu entry. Your everyday Firefox, the FAI settings and the pairing helper stay;
`node src/cli.js uninstall-native` removes the helper.

## Windows

On Windows FAI Browser supports Firefox only, and path 1 comes as one command. In PowerShell (no administrator rights):

```powershell
irm https://raw.githubusercontent.com/jedbjorn/fai-browser/main/scripts/install.ps1 | iex
```

[`scripts/install.ps1`](../../scripts/install.ps1) runs these steps; each one is per user:

1. **Node.js.** The current LTS build from nodejs.org, checked against its `SHASUMS256.txt`, into
   `%LOCALAPPDATA%\fai-browser\node\<version>`. FAI Browser alone uses it; a Node.js you already have is neither used
   nor changed.
2. **FAI Browser.** The latest GitHub release's source (over HTTPS, as a `git clone` would fetch it) into
   `%LOCALAPPDATA%\fai-browser\app\<version>-<time>`, a new folder each run, so an update never replaces files that
   a running FAI service, pairing helper or agent still uses. An older folder is removed once no process runs from it.
3. **The `fai-browser` command** (`%LOCALAPPDATA%\fai-browser\bin`, added to your user `PATH`) and a **FAI Browser**
   Start menu entry that runs `fai-browser launch`.
4. **Setup** (`scripts/setup.mjs --yes --download-firefox`): the pairing secret in `%APPDATA%\fai-browser`, Firefox's
   pairing helper (`HKCU\Software\Mozilla\NativeMessagingHosts\fai_browser`), the FAI service, registration with
   each coding agent it finds (Claude Code, Codex, OpenCode; an npm-installed `claude.cmd` works too), and the launch
   above: your official Firefox, or Mozilla's downloaded into `%LOCALAPPDATA%\fai-browser\browser\firefox` when none
   is installed, with the FAI profile and the signed add-on, paired.

Then restart your coding agent. Opening **FAI Browser** from the Start menu later starts the FAI service by itself
(Firefox's pairing helper starts it outside Firefox's process job, so it keeps running); a second click while it is
open says so instead of starting another copy.

- **Update:** run the same command again. It works while FAI Browser is open; agents pick up the new version when you
  restart them.
- **Remove:** `powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\fai-browser\uninstall.ps1"` asks, then
  closes FAI Browser (your everyday Firefox stays open), undoes the agent registrations (`fai-browser uninstall --host
  all`), and removes the pairing helper, the FAI profile with its sign-ins and history, FAI's Firefox copy, the private
  Node.js, the Start menu entry, the command and the settings.
- **Overrides** (environment variables, mostly for testing): `FAI_INSTALL_REF` (a release tag from `v0.9.0` on, or a
  branch), `FAI_INSTALL_ZIP` (a local source zip), `FAI_INSTALL_NO_SETUP=1` (files only), `FAI_INSTALL_ROOT`.

From a checkout instead (`git clone`, then `node scripts/setup.mjs`), setup on Windows also sets up Firefox only.

## 2. Add to your Firefox

1. `npm run setup` (pairing secret, the pairing helper for Firefox, the service, your agents). Answer **n** to the profile
   question.
2. Download `fai-browser-firefox-<version>.xpi` from the
   [GitHub Releases](https://github.com/jedbjorn/fai-browser/releases) page and open it in Firefox (drag it into a window,
   or `about:addons`, gear menu, **Install Add-on From File**). It is signed by Mozilla and updates itself.
3. Click the FAI Browser button on the toolbar: it should say **Connected to the FAI service**.

Firefox 140 or newer, not the Snap or Flatpak build (see above; `node src/cli.js pair` and the popup's Advanced,
Connection field pair by hand if you must). The agent then works in that profile, signed in as you: approve requests
deliberately and use the lowest level. A separate profile (path 1) is safer.

## Chromium family, from source

Chrome, Chromium, Brave, Edge and Vivaldi 116+ load the extension unpacked; there is no store listing.

1. `npm run setup` installs the pairing helper for every Chromium-family browser it finds.
2. Open `chrome://extensions` (`brave://extensions`, `edge://extensions`), turn on **Developer mode**, click
   **Load unpacked** and pick the `extension/` folder. The manifest pins the extension ID the pairing helper trusts.
3. Pin the FAI Browser icon (puzzle-piece menu, then the pin).

## Updating

FAI Browser follows **tagged GitHub releases** only, never `main`. About once a day the local service asks GitHub's
releases API whether a newer release is out (an anonymous request; only if the API answers 404 does it fall back to
your clone's remote with `git ls-remote` and your own git credentials, where an ssh agent or credential helper that
confirms each use (1Password, `ssh-add -c`, a FIDO key) may ask about once a day; `FAI_UPDATE_CHECK=0` or `"updateCheck": false`
in `config.json` turns the automatic check off). When one is, the popup shows **Update available vX.Y.Z** with the release notes and an
**Update** button, and `node src/cli.js status` says so. Nothing installs until you click or run:

```sh
node src/cli.js update --check   # look only
node src/cli.js update           # install the latest release
```

The update moves your clone to the release tag (fast-forwards `main`, or checks the tag out when you are on a release
checkout), runs `npm ci` when the lock file changed (best effort), refreshes the pairing helper and the skill you
installed, and restarts the local service. It refuses, and says what to do, while an agent holds a tab, when the clone
has local changes or unpushed commits, is on another branch, or does not come from github.com/jedbjorn/fai-browser.
While it runs, new agent tab requests wait ("retry in a minute"). If the refresh or restart fails after the move it rolls
back to the previous version; if it was interrupted, run `node src/cli.js update` again to finish it.

- **Chromium, from source**: the extension reloads itself once the new service answers. Restart your coding agent.
- **Firefox (paths 1 and 2)**: Firefox updates the signed add-on by itself (its `update_url`); the updater only updates
  the clone and the service. If Firefox has not picked it up yet, install the new `.xpi` from the Releases page by hand.
  A temporary add-on from `dist/firefox/` needs `npm run build:firefox` and a reload.

Details: [Updates](../REFERENCE.md#updates).

## Next

[Getting started](getting-started.md) (your first task), [Firefox notes](firefox.md),
[troubleshooting](troubleshooting.md).

Firefox and the Firefox logo are trademarks of the Mozilla Foundation. FAI Browser is not affiliated with or endorsed by
Mozilla; it starts the Firefox you have, or one downloaded directly from Mozilla, without modifying it.
