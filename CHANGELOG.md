# Changelog

All notable changes to FAI Browser. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project aims to follow [Semantic Versioning](https://semver.org/) from 1.0; until then minor versions may change interfaces.

Version 0.2.0 was the first published state; the 0.3 series introduces the default agent driver and signed Firefox add-on.

## Unreleased (approved frames)

### Added

- Cross-origin frames whose origin the request approved are read and acted on (#11). A frame from another origin inside the approved page (the content blades of the Microsoft Entra admin center and the Azure portal, for example) is read when its own origin is one of the request's `origins` or under an approved domain root, nested up to four levels, at most eight per page. Its text, blocks and controls join the observation (control ids `f<n>.<id>`, with `frame` and `frameOrigin`); an act on such a control runs in that frame after its origin is probed again (a frame that moved to an unapproved origin refuses it with `cross_origin`, another document is `stale`). Inside the frame the same page script applies the same level, `forbid`, Approve gate, secret redaction, vault, password and sign-in detection and consent rules, and one page context covers the tab (a purchase page, a password or payment field or a credentials page anywhere restricts every document). Screenshots place each approved frame's own secret boxes where the frame is at the capture and box every cross-origin frame that was not read. A frame act first re-reads the page (a changed page is `stale`; a page that turned into a checkout restricts the frame), a page act first re-reads the frames' facts, and the Approve card names a frame control's own origin "in a frame of" the page. No new permission: frames are found with `scripting.executeScript` (`allFrames`).
- `frames` in observations and act results lists the page's cross-origin frames: the ones read and, for each one not read, its origin and why (`not_approved`, `no_access`, `sandboxed`, `limit`, `unavailable`), as untrusted page content; the trusted `next` counts the unread frames and tells the agent to ask for their origins. Frames from unapproved origins are still never read.
- An `origin_changed` pause names the origin the tab went to (origin only): `leftOrigin` in the request view and the paused result, as untrusted text, so the agent can request it up front (a sign-in hop, for example).

### Changed

- Approving in the request modal asks the browser for the tab's host and up to 10 other exact origins of the request in one prompt (not only the tab's host); the ones it adds are removed again when the session ends, and a list that cannot be asked for falls back to the tab's host.
- Screenshots box every cross-origin frame, `<object>` and `<embed>` FAI did not read (before, only Strict mode and payment or sign-in widgets).
- A point click on any cross-origin frame stays refused as `point_frame`; name an approved frame control's action id instead.

### Known limits

- A toolbar-icon approval (`activeTab`) reaches only the tab's own origin: approved frames on other origins come back as `no_access`. Approve from the request modal, or allow all sites.
- Firefox uses the same code path but is untested; it has no `location.ancestorOrigins`, so the in-frame ancestor check is Chromium only.
- Structured records and derived views (tables, charts) come from the top document only; frame content arrives as blocks and text. Scrolling scrolls the top document.

## 0.5.1 (2026-11-09)

### Added

- Several browsers at once. The extension may be paired in more than one browser (the Firefox add-on and an unpacked Chromium, or two Chrome profiles) with one FAI service, and all of them stay connected. Each install keeps a random browser id and reports its product (`firefox`, `chrome`, `chromium`, `edge`, `brave`, ...). A new tab request opens in the browser you used FAI in last (your last approval, popup open or toolbar click); every other browser's popup lists it as **In another browser** with **Open here**, which moves it there. Agents may name a browser: `browser` on `fai_browser_open` and `fai_browser_run`, `request-tab --browser`, `POST /v1/requests`; one that is not connected is refused with `browser_not_connected`, naming the connected ones. Each browser holds its own tab: approving in one no longer ends the other's, commands go only to the browser that holds the tab, and a browser that disconnects or restarts pauses only its own.
- `daemon status`, `status` and `fai_browser_status` list the connected browsers (`extension.browsers`: id, product, name, browser version, transport, connectedAt, lastSeen, lastUsedAt, leases); request views carry the `browser` that holds or awaits the tab, and the granted line names it. A connection that keeps dropping adds the warning `extension_flapping`; two installs sharing one identity (a copied profile) add `extension_duplicate_identity`.
- Each browser keeps its own popup settings: its budget, "Open requested pages right away" and Approve gate asks apply to the requests it holds or awaits. The browser used last is remembered across restarts and updates (`browsers.json` in the state directory: ids, extension Origins and times only).
- A request named for (or moved to) a browser that goes away moves to the one used last after a minute, and the agent's approval hint says so until the user moves or approves it.
- An extension whose browser id the service refuses (bound to another extension install) picks a new id once by itself; a second refusal stops with a popup message, and status shows `extension_identity_refused`.

### Security

- A browser id is bound to the extension Origin it first connected from, so a client holding the pairing secret cannot take over another browser's connection or its tab by claiming its id; extensions are never sent other browsers' ids or leases; results from a connection that was not sent the command are dropped, and only the browser holding a tab can release it.

### Legacy extensions

- The 0.5.0 Firefox add-on and older unpacked builds connect side by side with other browsers without fighting, but see only their own requests and no Open here until they update (the next release's signed add-on carries it). Two legacy Chromium-family builds of the same unpacked extension still count as one browser and can flap; `extension_flapping` shows it.

### Fixed

- Two paired browsers no longer replace each other's connection about twice a second, forever (issue #9). The service closed the previous connection with code 4000 on every new one, whichever browser it came from, and each extension reconnected at once; windows flickered, the agent could not hold a tab, and status still said connected. Now only a newer connection of the same browser (a restarted worker) replaces the old one, with code 4003, on which the extension does not reconnect (it says "Another copy of this browser profile took the FAI connection" and tries again when the popup opens or after five minutes). Against an older service the extension backs off on repeated 4000s (4, 8, 15 s) and its popup says another browser keeps taking the connection; a connection only resets the backoff after lasting 10 s.

### Changed

- Only one tab lease is active per browser (it was one in all); approving a second request in the same browser still supersedes the first there.
- The tool list grows by the `browser` field (about 150 bytes).

## 0.5.0 (2026-11-09)

### Added

- Update notice and one-click update from tagged GitHub releases. About once a day the local service checks GitHub's releases API anonymously (`FAI_UPDATE_CHECK=0` or `"updateCheck": false` turns it off). The popup then shows "Update available vX.Y.Z" with release notes and an Update button, and status and `fai_browser_status` carry an `update` field. The update installs only on that click or `node src/cli.js update` (`--check` only looks). It moves the git clone to the release tag, refreshes pairing and installed skills, restarts the service and reloads the unpacked Chromium extension. It refuses while a tab lease is held, on local changes, unpushed commits, another branch or another remote, and rolls back if a step fails after the move. While an update installs, new tab requests and approvals wait. For a private repository the check falls back to `git ls-remote` with the user's own git credentials (status `source: git`). No FAI secret reaches git, npm or the restarted service.
- Clicking Resume (or approving) in the extension can wake the agent. `fai-browser wait <requestId> --until active [--timeout 30m]` blocks on the daemon's long poll until the tab is usable again and prints one JSON line: exit 0 active, 3 the request ended (released, expired, denied, cancelled or unknown to the daemon), 2 timeout, 130 interrupted. It never starts a daemon: it rides out a dropped connection or a restart with a short backoff, and after 30 s without a daemon ends as `unknown` (`daemon_gone`), since tab requests do not survive a restart. A failure still prints one line with a `next`; `next` follows the driver (`observe`, or `rerun` with `fai_browser_run` for Jev).
- Paused and pending relays (Agent direct and Jev) name that command in `next.text` with the absolute node and CLI paths, so a host that is notified when a background command exits (Claude Code's `run_in_background`) starts it (unless one is already running) and ends its turn instead of waiting for the user to type "resumed"; other hosts ask the user to say when they are done.

### Changed

- The paused lease messages ask the user to click Resume in the FAI Browser extension and leave how to continue to `next`; after Resume or approval the agent observes the page (Agent direct) instead of calling `fai_browser_open` again: the request keeps the opening `task`, which observe ranks the digest by.
- `--until` and `--timeout` are refused by every command but `wait`.

### Fixed

- Chrome's own error page on the approved site (an HTTP error sent without a page body, such as an empty 500, or a dropped or refused connection) no longer pauses the task as `origin_changed` or fails as `unsupported`. The extension reports it as an error page (`browser_error_page` warning), a run or act that lands there ends `error_page`, the session stays active, and a reload or another approved URL works once the site is back.

### Known limits

- With a toolbar (activeTab) approval, Chrome withdraws access when its own error page appears, so that session still pauses as `origin_changed`; approve the tab again once the site is back. Approval in the request modal (browser site access) keeps the session. Firefox is not covered by this fix (untested): its network error pages (`about:neterror`) may still pause as `origin_changed`.
- With the repository private, only final releases may carry a plain `vX.Y.Z` tag (the git fallback cannot see prerelease flags), and Firefox cannot fetch the signed add-on's update by itself.
- Project-level skill installs are not refreshed by an update; re-run `node src/cli.js install --host ...` there.

## 0.4.0 (2026-11-07)

### Added

- Task tabs open in the existing browser window. Optional multiple-task-tab access supports up to eight task-owned tabs on the approved site while leaving personal tabs outside the task.
- In-page request approval for Read, Use and search/filter tasks, with native browser site permission and the toolbar approval alternative.
- Resumable public pilot tooling and a public site reporting six exploratory runs across three task pairs with outcome, token, timing and provenance details.
- Firefox development and detection tools, floating-menu support, and stronger structured record extraction.

### Fixed

- Task-tab ownership, popup and navigation boundaries, permission cleanup, and recovery after worker restarts.
- Search rerenders, independent record lists, stale action revisions, and benchmark approval isolation.

### Known limits

- Screenshots can still require a toolbar gesture after in-page approval.
- Public pilot measurements are exploratory, include partial outcomes and browser/session differences, and do not establish a general performance win.
- Native in-page approval was checked manually in Firefox; Chromium coverage is automated.

## 0.3.2 (2026-11-06)

### Fixed

- File uploads accept the user's bound, single-use approval. Missing, forged, reused or mismatched approvals remain refused.

### Known limits

- Secret handles do not fill password sign-in forms, including in Test site mode. Such a task may require a user handoff.

## 0.3.1 (signed preview, not published)

### Fixed

- Approval cards show the complete currency amount, including thousands separators and decimals.
- In-memory secret handles survive replacement by a new user-approved lease; explicit stop, release and expiry still clear them.
- Run test files one at a time to keep browser performance checks from failing under parallel browser contention.

### Added

- Reproducible isolated Firefox demo capture, reviewed video and screenshots for the documentation and website.

## 0.3.0 (2026-11-06)

The theme of 0.3.0: **your agent drives by default**, the browser is safe to hand to it (approvals, secret redaction, secret
handles), and Firefox joins Chromium.

### Added

- **Agent direct driver (the default).** The host agent chooses every action: `fai_browser_open` requests approval and returns
  a compact page (digest ranked by the task, offered actions, a single-use revision); `fai_browser_act` runs one offered
  action or a point click and returns the next page; `fai_browser_observe`, `fai_browser_wait`, `fai_browser_status`,
  `fai_browser_release` and `fai_browser_evidence` complete the surface. No provider key, no provider calls. The daemon owns the
  driver choice (`X-Fai-Driver`); the MCP server follows it without an agent restart. Standing terms (forbidden labels,
  supplied values, allowed URLs) accumulate per request and cannot be removed. A filled search field offers "press Enter".
- **Approve gate.** Purchases, deletions, credential actions and submissions above the granted level are offered marked
  `needsApproval`; acting on one opens an "Approve this action?" window with the site, kind, control label, total and the
  agent's reason, and needs **Approve once** (single-use id bound to tab, lease, revision, control and label hash; 60 s;
  Deny and timeout are distinct outcomes). Three settings in the popup. Works on plain-http test pages (pure-JS SHA-256
  label hash).
- **Secret redaction.** Always-on, deterministic redaction of dozens of known key formats, context-detected tokens,
  private keys, card numbers (Luhn), passwords, TOTP seeds, recovery codes and signed URL parameters, as
  `[secret:N kind prefix...last4 len L]` placeholders in page text, labels, URLs, traces, logs, HTTP responses and MCP messages.
  The rules live in `src/secrets.js` and are byte-copied into the extension (drift-tested). Standard and Strict modes,
  relaxed origins, secret-page detection. `scripts/secret-sweep.mjs` audits every fixture page.
- **Screenshot redaction.** Boxes are filled on the captured pixels before a screenshot leaves the extension (secrets found
  by the text scan, password and payment fields, payment and sign-in widget frames; canvases and other frames in Strict
  mode), checked again after capture, failing closed.
- **Secret handles.** `fill_secret` and `copy_secret` let an agent paste or copy a secret it never sees, by `secret:N` handle, always
  with the user's approval; the vault lives in the extension worker's memory.
- **Native messaging pairing.** `npm run setup` installs a native host for every Chromium-family browser and Firefox found; the
  extension pairs by itself, nothing to copy. Setup also registers `fai-browser-mcp` with Claude Code, Codex and OpenCode.
  State moved to per-user directories (`~/.config/fai-browser`, `~/Library/Application Support/fai-browser`).
- **Firefox support** (ESR 140+): `npm run build:firefox` builds `dist/firefox` from the same extension with a compat layer
  (offscreen frame, exact-origin permission keeper, `navigator.clipboard` in the background page), a Marionette smoke test and
  `web-ext lint` with 0 errors.
- **Popup and approval UX.** Read / Use / Act / Test site naming, preselected to the asked level, approval window, pin hint,
  setup card, Advanced section with the driver switch, budgets and test sites.
- Tool search friendliness: `alwaysLoad` metadata on the three loop tools, short server instructions bounded by tests.

### Changed

- The skill is now the direct loop (open, read, act, verify); the Jev guidance moved to `skills/fai-browser/jev.md`, marked
  experimental. README, REFERENCE and ARCHITECTURE lead with your agent driving.
- Level names in the user interface are Read, Use, Act and Test site; API names (`read-only`, `reversible`, `interactive`,
  `full`, `testing`) are unchanged.
- Docs reorganized into `docs/design/` and `docs/results/`.
- Purchase detection narrowed to purchase pages and checkout regions, so Save, Search and Add to cart keep their own class.

### Removed

- The Phase 1 in-process companion and its test paths (use the FAI service).

### Experimental

- The **Jev autopilot** (an optional TypeSafe Jev model drives instead of your agent; `fai_browser_run`, step lists, retries, site profiles) is opt-in: `npm run setup -- --driver jev` or the
  popup switch once a key is saved. The published benchmarks measure it.

## Between 0.2.0 and 0.3.0: Jev autopilot improvements

All of this applies to the Jev autopilot unless noted.

- Host-turn reduction: server instructions carry the common path; `fai_browser_run` is loaded eagerly; per-request usage, warm-up,
  capture only at the last step, parallel answer ranking.
- Multi-step runs (`steps[]`) with confirmed-answer placeholders; in-call retries (second opinion for links, read-only back-out);
  request slimming switches; stale-revision re-resolution.
- **Domain roots**: `https://*.example.com` origins, Public Suffix List matching, optional host permissions at Approve, 24-hour memory.
- Control offering: accessible names, descriptors for unnamed controls, relevance-ranked observation cap, combobox clicks.
- Long-horizon corpus (five 12 to 15 hop fixtures), state-reading views (SVG chart values, keyed grids), fact memory and answer
  aggregation, named-control policy, termination and caps; fixes from live tests on a Google Flights-like fixture.
- Configurable guardrails (`policy.forbid`, `config.json`), intent-clearing floor of 0.9 for ambiguous refused controls.
- Approval UX rework, budget setting (50 calls / 20 minutes), point clicks on screenshots, escalation ladder.
- Task sub-skills for flight and hotel search under `tasks/`, Google Flights site profile.
- Site profiles (experimental, opt-in); `bench/live` runner for real hosts; `docs/TESTED.md`.

## 0.2.0 (2026-10-04)

First published state: daemon, MCP server and skill, Chromium extension (Manifest V3) with per-request approval, permission
levels (read-only, reversible, interactive, full, testing), guardrails, verified outcomes through expectations, traces with
retention, the TypeSafe Jev provider, CLI and SDK client, and the benchmark harness with the six-host comparison against
Playwright MCP (1.24x to 1.73x faster, 1.19x to 2.28x cheaper, 4.3x to 6.0x fewer tool calls on local fixtures).
