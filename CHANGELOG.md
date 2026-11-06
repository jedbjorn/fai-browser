# Changelog

All notable changes to FAI Browser. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project aims to follow [Semantic Versioning](https://semver.org/) from 1.0; until then minor versions may change interfaces.

Version 0.2.0 was the first published state; the 0.3 series introduces the default agent driver and signed Firefox add-on.

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
