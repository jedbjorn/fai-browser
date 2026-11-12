# Contributing to FAI Browser

Thanks for helping. FAI Browser lets a coding agent drive one browser tab the user approved, so the boundaries that keep
that safe are the part of the code that needs the most care. This page covers how to set up, test and change it.

By contributing you agree that your work is released under the [MIT license](LICENSE) and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security problems go to [SECURITY.md](SECURITY.md), not to a public issue.

## Dev setup

Requirements: Node 22 or newer, a Chromium-family browser for the browser-backed tests, Linux or macOS. Firefox 140+ is
only needed for `npm run smoke:firefox`. Development happens on Linux or macOS; Windows users install with
`scripts/install.ps1` (Firefox only). CI also runs the browserless suite (`npm run test:browserless`) on
`windows-latest` and `macos-latest`, and the installers on both, the browser-backed tests on Linux only.

```sh
git clone https://github.com/jedbjorn/fai-browser && cd fai-browser
npm ci                         # the only dependencies are dev dependencies (MCP SDK for tests, playwright-core)
node examples/fake-demo.js     # first check, no browser and no key: an in-memory bridge, prints a result
node --test test/secrets.test.js test/guardrails-policy.test.js   # a fast, browserless first test run
```

To use your checkout as your agent's browser: `npm run setup` (pairing secret, native messaging host, daemon,
agent registration), load `extension/` unpacked at `chrome://extensions` (Developer mode), pin the icon, restart the agent.
State lives outside the checkout, in two directories on Linux: `~/.config/fai-browser` (`.env.local`, `config.json`, the native
host launcher) and `~/.local/state/fai-browser` (`client-token`, `daemon.json`, `daemon.lock`, `logs/`, `artifacts/`). On macOS it
is the single directory `~/Library/Application Support/fai-browser`. Never commit or paste anything from them, and never
read `.env.local` or `client-token` aloud in an issue. See [getting-started](docs/guide/getting-started.md) for the full setup. Firefox: `npm run build:firefox`, then load
`dist/firefox/manifest.json` from `about:debugging`. The full manual is [docs/REFERENCE.md](docs/REFERENCE.md).

Runtime dependencies: none, and that is a rule. `src/` and `extension/` use only Node built-ins and browser APIs. Think twice
before proposing one.

## Code layout

| Path | What lives there |
|---|---|
| `src/mcp.js`, `src/mcp-main.js` | The MCP server (`fai-browser-mcp`): tool schemas, server instructions, argument validation |
| `src/daemon.js`, `src/bridge.js`, `src/client.js`, `src/cli.js` | The local service: tab requests and leases, the WebSocket/long-poll hub to the extension, the HTTP API, the SDK client and the CLI |
| `src/runtime.js`, `src/result.js`, `src/digest.js`, `src/relevance.js`, `src/expectation.js` | Observations, offered actions, ranking, verification and the result shapes |
| `src/guardrails.js`, `src/oversight.js`, `src/origins.js` | Permission levels, label rules, origin matching (Public Suffix List based) |
| `src/secrets.js` | Secret redaction rules |
| `src/native.js`, `src/native-host.js`, `src/install.js`, `src/home.js`, `src/settings.js` | Native messaging pairing, agent registration, per-user state and settings |
| `src/facts.js` | Fact memory: answer candidates across the pages an act visited |
| `extension/` | The browser extension: `background.js` (service worker / Firefox event page), `page.js` (the content script that reads the page and acts), `offscreen.js` (screenshot redaction, clipboard), popup and approval UI, `compat.js` (Firefox shim) |
| `skills/fai-browser/`, `tasks/` | The host-facing skill and task sub-skills (flight and hotel search) |
| `fixtures/`, `test/` | Local fake sites and the test suite |
| `bench/` | The benchmark and QA harnesses (maintainer tools) |
| `docs/` | `REFERENCE.md` (exhaustive), `guide/` (task-oriented), `design/` |

Site-specific logic does not belong in `src/`. A new site gets a sub-skill under `tasks/<name>/`: a short `SKILL.md` guide and, when needed, the task's vocabulary in `index.js`.

## Running the tests

```sh
npm test                                   # node --test --test-concurrency=1 test/*.test.js
node --test test/guardrails-drift.test.js  # one file
node scripts/secret-sweep.mjs [--strict]   # observe every fixture page, list every redaction placeholder
npm run browser-smoke                      # headless Chromium end to end
npm run smoke:firefox                      # headless Firefox 159 through Marionette
npm run lint:firefox                       # web-ext lint of dist/firefox
```

Browser-backed tests find Chromium through `CHROMIUM_PATH`. To get one, as CI does (`.github/workflows/ci.yml`):

```sh
npx playwright-core install chromium     # add --with-deps on a fresh Linux box
export CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())")
```

Any installed Chrome or Chromium binary also works. The suite is
large and several tests launch browsers, so on a small or shared machine **run it inside a memory cap** so a runaway test is
killed in its own scope and not your terminal session. A pattern that works on systemd Linux:

```sh
systemd-run --user --scope --quiet -p MemoryMax=2500M -p MemorySwapMax=256M \
  timeout 240 node --test --test-concurrency=1 test/<file>.test.js
```

Generalized:

- **One heavy process at a time.** `--test-concurrency=1`, no parallel suites, benches or browsers. Check `free -m` first.
- **Cap the scope.** Linux with systemd: `systemd-run --user --scope -p MemoryMax=...`. Without systemd: `ulimit -v` does
  not work well with V8 and browsers; use `node --max-old-space-size=1536` for Node and run browser tests one file at a time.
  macOS: run one file at a time and watch Activity Monitor.
- **Wrap in `timeout`** so a hung test cannot hold a browser open (`gtimeout` from `brew install coreutils` on macOS).
- **Run new or untrusted tests capped first**, then uncapped once you know their footprint (the popup tests peak near 1 GB).
- **Never assert directly on a Playwright object** (an element handle, page or locator): when the assertion fails, Node
  inspects the whole object graph and can take gigabytes. Compare `await locator.count()` or a plain value.
- Clean up temp directories and stop any daemon your test started (`createDaemon` with a temporary `FAI_HOME`).
- A failure that appears only when many tests run at once (observe-speed or PNG tests under heavy load) is load, not a regression: rerun that file alone.

## Safety boundaries that must stay intact

Several rule sets exist twice because the extension runs without Node: once in `src/` (used by the daemon, runtime and
tests) and once as a **byte-identical copy** inside the extension scripts. Drift tests compare them and fail when only one
side changes. Edit the `src/` copy, then sync the other:

| Rules | Source of truth | Copies | How to sync | Drift test |
|---|---|---|---|---|
| Secret redaction (`<secret-rules>` block) | `src/secrets.js` | `extension/background.js` (as is), `extension/page.js` (indented two spaces) | `node scripts/sync-secret-rules.mjs` | `test/secrets.test.js` |
| Guardrail label and field patterns: `PURCHASE`, `COMMIT_OTHER`, `SUBMIT_WORDS`, `DELETE_WORDS`, `SIGN_IN_WORDS`, `SAFE_SUBMIT`, `PAYMENT_AUTOCOMPLETE`, `PAYMENT_FIELD`, `normalizeLabel`, `forbidPattern`, and the Approve-gate classes | `src/guardrails.js` | `extension/page.js` (copied byte for byte, two-space closure indent) | edit both; the test prints which one differs | `test/guardrails-drift.test.js`, `test/approve-gate*.test.js` |
| Level table and capabilities | `src/guardrails.js` | `extension/background.js`, `extension/permissions.js` | edit all three | `test/guardrails-drift.test.js`, `test/extension-permissions.test.js` |
| Site matching (`<site-match>` block, PSL based) | `src/origins.js` | `extension/permissions.js`, `extension/background.js` | edit all three; `npm run update-psl` refreshes the list | `test/origins.test.js` |

Rules of thumb for these files:

- A change that makes the agent **more capable** (a new action class, a looser pattern, a new level) needs a test that
  shows the new boundary, and a matching change to the Approve gate or the docs in the same pull request.
- A change that makes the agent **less capable** (a new forbidden label) is cheap and welcome; add a fixture page.
- Never add a "disable the guardrail" switch that an agent can reach. User settings live in `chrome.storage.local`,
  readable only by extension pages, not in `config.json`, which an agent with a shell could edit.
- Redaction is deterministic and always on. A new secret format is one rule plus a fake value in
  `fixtures/secrets/fakes.js` (fakes are assembled from fragments and marked `FAKE`, so no key-shaped string sits in the repo).
- Page text is untrusted input everywhere: it goes under the "untrusted page text" heading in tool results and never into
  trusted fields.

## Changing the agent loop

For changes to observation, ranking or the result shape, measure before and after with the harness in
[bench/](bench/README.md), one change per run; `npm run bench` uses an in-memory bridge and needs no browser. Tool schemas and
server instructions are re-sent to the host model on every request, so every byte counts: `test/mcp.test.js` and
`test/agent-direct.test.js` bound their size.

## Pull requests

1. Open an issue first for anything larger than a fix, especially a change to a guardrail, the Approve gate or the secret rules.
2. Branch from `main`, keep the change focused, add or update tests, run the affected test files (capped), and run
   `node scripts/secret-scan.mjs` before committing anything under `bench/`.
3. Update `docs/REFERENCE.md` (and `docs/guide/` if user-facing), `CHANGELOG.md` and the types in `src/index.d.ts` when the public surface changes.
4. Commit messages: a short imperative summary, then a paragraph on why. No generated logs, traces or screenshots from real sites.
5. CI must be green (Node 22 and 24).

New test pages go in `fixtures/` and must be fake: no real accounts, names, card numbers or keys.

## Site-compatibility reports

If FAI misreads a site, the most useful report is the observation: run `fai_browser_observe`, note the `warnings` and which
control was missing or wrongly offered, and use the **Site compatibility** issue template. Do not paste page text that
contains personal data; the redaction placeholders are safe to include.
