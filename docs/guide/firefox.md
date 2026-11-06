# Firefox

FAI Browser supports **Firefox 140 ESR and newer** with the same extension code as Chromium. Details and the
engineering notes are in [REFERENCE.md: Firefox](../REFERENCE.md#firefox). Firefox for Android and Safari are not supported.

## Install

[install.md](install.md) has both ways: **Download FAI Browser** (`npm run setup`, or `node src/cli.js launch`: official
Firefox with a separate FAI profile and the signed add-on, paired) and **Add to your Firefox** (the signed `.xpi` from the
GitHub Releases). Both use the add-on Mozilla signed (unlisted, ID `fai-browser@jedbjorn.github.io`), which updates
itself.

## Development builds

```sh
npm run build:firefox      # writes dist/firefox/ from extension/, plus a Firefox manifest
npm run setup              # installs the pairing helper for Firefox too
```

Then `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, choose `dist/firefox/manifest.json`. A temporary add-on
is removed when Firefox restarts. `npx web-ext run --source-dir dist/firefox` starts a throwaway profile with it loaded.
Release Firefox installs only signed add-ons; Developer Edition, Nightly, ESR and unbranded builds also take an unsigned
one with `xpinstall.signatures.required` set to `false`.

Release builds: `npm run package` (the reproducible zip), `npm run sign:firefox` (Mozilla's unlisted signature, with the
maintainer's AMO API key) and the `Release` workflow on a version tag, which also publishes `updates.json` and `SHA256SUMS`.

## Permissions and the gaps

- Firefox drops `activeTab` at a tab's **first navigation**. So the approval click also asks Firefox for the request's exact origins
  (one Firefox prompt per new site); the add-on removes each grant it caused when the request ends. Declining keeps the approval, but the session pauses at the first navigation.
- Firefox host permissions take **no port**: approving `http://127.0.0.1:8080` grants `http://127.0.0.1` on every port.
- **Screenshots:** Firefox's `captureVisibleTab` needs `activeTab` or all-sites access. After the first navigation there is **no
  screenshot** unless you turn on **Access your data for all websites** (`about:addons`, FAI Browser, Permissions). The add-on
  never asks for it. Page text, actions and the Approve gate work either way, and redaction boxes still apply to the screenshots that are taken.
- The pairing, approval windows, tab group mark, secret handles and `copy_secret` (through the background page's clipboard)
  work as on Chromium.

## Pairing

`npm run setup` and `node src/cli.js launch` write the host manifest to `~/.mozilla/native-messaging-hosts/` (Linux), which current
Firefox reads for every profile, including the FAI profile, or `~/Library/Application Support/Mozilla/NativeMessagingHosts/`
(macOS). It allows only the add-on IDs `fai-browser@jedbjorn.github.io` (signed) and `fai-browser@local` (older dev builds). **Snap and Flatpak Firefox are sandboxed and cannot start the native host**: pair by hand with
`node src/cli.js pair` and paste the secret in the popup under Advanced, Connection.

## Testing

`npm run smoke:launcher` runs `fai-browser launch` against headless Firefox in a temporary HOME: the profile's `user.js`, the
add-on placement (`--xpi <signed.xpi>`: installed from the profile and active without a temporary load; without it, an
unsigned build must be refused), pairing through the native host and the welcome page. `npm run smoke:firefox` starts headless Firefox on a throwaway profile through Marionette and runs a set of checks: pairing, request
and approval, observe, an annotated screenshot, an act, navigation, the screenshot gap and the all-sites opt-in, and redaction
boxes on a page of fake keys. `npm run lint:firefox` runs `web-ext lint` (0 errors). On a small machine run them
[memory-capped](../../CONTRIBUTING.md#running-the-tests).
