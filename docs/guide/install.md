# Install

FAI Browser is distributed for **Firefox**. There are two ways to get it, plus a from-source path for Chromium-family
browsers:

| | What you get | For |
|---|---|---|
| **1. Download FAI Browser** (recommended) | Official Firefox with a separate **FAI** profile, the signed add-on preinstalled and paired | Most people: the agent never sees your everyday browsing |
| **2. Add to your Firefox** | The signed add-on in a Firefox profile you already use | You want the agent in a profile you already have |
| Chromium, from source | `extension/` loaded unpacked in Chrome, Brave, Edge, Vivaldi | Developers |

All three need the local part (the FAI service and the MCP server) from this repository, Node 22 or newer, and Linux or
macOS (Windows is untested).

```sh
git clone https://github.com/jedbjorn/fai-browser
cd fai-browser
npm ci
```

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

### Shortcuts on macOS and Windows

The launcher writes a menu entry on Linux only. On **macOS**, open Script Editor, paste
`do shell script "'/usr/local/bin/node' '/path/to/fai-browser/src/cli.js' launch --from-desktop"` (your `which node`
and checkout path), and save it as an Application named "FAI Browser". On **Windows** (untested), create a shortcut to
`"C:\Program Files\nodejs\node.exe" "C:\path\to\fai-browser\src\cli.js" launch --from-desktop`.

### Remove it

```sh
node src/cli.js uninstall-launcher   # lists what it removes and asks; --yes to skip the question
```

It removes the launcher data directory (the FAI profile with its sign-ins and history, FAI's Firefox copy, the add-on
file) and the menu entry. Your everyday Firefox, the FAI settings and the pairing helper stay;
`node src/cli.js uninstall-native` removes the helper.

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
releases API whether a newer release is out (an anonymous request; `FAI_UPDATE_CHECK=0` or `"updateCheck": false` in
`config.json` turns it off). When one is, the popup shows **Update available vX.Y.Z** with the release notes and an
**Update** button, and `node src/cli.js status` says so. Nothing installs until you click or run:

```sh
node src/cli.js update --check   # look only
node src/cli.js update           # install the latest release
```

The update moves your clone to the release tag (fast-forwards `main`, or checks the tag out when you are on a release
checkout), runs `npm ci` when the lock file changed, refreshes the pairing helper and the skill you installed, and
restarts the local service. It refuses, and says what to do, while an agent holds a tab, when the clone has local
changes or unpushed commits, is on another branch, or does not come from github.com/jedbjorn/fai-browser. If a step
fails after the move it rolls back to the previous version.

- **Chromium, from source**: the extension reloads itself once the new service answers. Restart your coding agent.
- **Firefox (paths 1 and 2)**: Firefox updates the signed add-on by itself (its `update_url`); the updater only updates
  the clone and the service. A temporary add-on from `dist/firefox/` needs `npm run build:firefox` and a reload.

Details: [Updates](../REFERENCE.md#updates).

## Next

[Getting started](getting-started.md) (your first task), [Firefox notes](firefox.md),
[troubleshooting](troubleshooting.md).

Firefox and the Firefox logo are trademarks of the Mozilla Foundation. FAI Browser is not affiliated with or endorsed by
Mozilla; it starts the Firefox you have, or one downloaded directly from Mozilla, without modifying it.
