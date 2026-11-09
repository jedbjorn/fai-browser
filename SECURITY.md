# Security policy

FAI Browser gives a coding agent access to a browser tab you approved, so security reports are taken seriously and handled
privately first.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting (enabled on this repository), the primary channel:

1. Go to the repository's **Security** tab, then **Report a vulnerability**
   (`https://github.com/jedbjorn/fai-browser/security/advisories/new`).
2. Describe what you found, how to reproduce it (a fixture page or a short MCP session is ideal), the affected version or
   commit, and what an attacker gains.

If you cannot use GitHub advisories, email 267177294+jedbjorn@users.noreply.github.com with "FAI Browser security" in the subject (no details in public issues).

What to expect: an acknowledgement within 3 working days, a first assessment within 10, and a fix or mitigation plan
within 30 days for confirmed issues, coordinated with you on disclosure. Credit in the advisory and the changelog unless you prefer not to be named.

Supported versions: the latest release and `main`. Before 1.0 there are no backports.

### What counts as a vulnerability

In scope (examples):

- An agent, a web page or a local process **raising its own level** (obtaining `full` or `testing` without the user's grant),
  reaching a tab, origin or browser-internal page the user did not approve, or approving its own Approve-gate request.
- A purchase, delete, credential action, sign-in or consent accept that runs without the grant or the Approve click it needs.
- A **secret value** (matching a documented format or context rule, or a password/payment field) reaching the agent in a
  result, a trace, a log, the daemon API, a screenshot, or an MCP message.
- The pairing secret or a secret-handle value leaving the extension worker or the vault.
- A web page detecting, modifying or escaping the content script (reading the pairing secret, forging an extension message).
- The daemon accepting a request without the pairing secret, or from a non-loopback address or a foreign web origin (CORS, DNS rebinding).
- Native messaging host accepting a caller other than the FAI extension.
- A way to make the extension or daemon accept input from an untrusted build or origin (for example a build with the pinned ID
  that was not made from this source) without the user's explicit action.

Out of scope: social engineering of the user into approving something obviously harmful; a model that disobeys its
instructions inside a level the user granted (see below); findings that need an already-compromised machine or browser
profile; denial of service by the user's own agent; vulnerabilities in third-party sites or in the host agent itself.

## Threat model summary

FAI Browser assumes: the **user** is trusted and decides; the **host agent** (Claude Code, Codex, OpenCode, ...) is
semi-trusted: it follows the user but can be misled; **page content** is untrusted; the machine and the user's OS account
are trusted. The local daemon, the extension and the host talk only over `127.0.0.1` and native messaging.

### What FAI protects against

| Threat | Mechanism |
|---|---|
| The agent picking its own tab or reading other tabs | One tab per request, approved by a click in the extension; nothing selects a tab silently. Browser-internal pages are never used. |
| The agent acting on sites you did not name | Exact origins (or one registrable-domain root, shown to you as "all of example.com"); checked in the daemon, the worker and the page script |
| The agent doing more than you meant | Four levels you pick per tab (Read, Use, Act, Test site); the run is clamped to your choice, and the receipt reports what was granted. Nothing the agent, a page or a config file sends can raise it |
| Purchases, deletions and credential actions | Offered as `needsApproval`; each click needs **Approve once** in the extension window (single-use, bound to tab, revision, control and label hash, valid 60 s). Typing into password or card fields and signing in are refused outside the Test-site level; with the Approve gate switched off, purchases are refused there too |
| A page showing secrets to the agent | Always-on deterministic redaction of known key formats, tokens, private keys, card numbers, passwords, TOTP seeds, recovery codes and signed URL parameters, in page text, labels, URLs, screenshots (pixels filled before they leave the extension), traces and logs |
| Making the agent use a secret without seeing it | Secret handles: `fill_secret` / `copy_secret` by `secret:N` handle, always with your approval; the value stays in the extension worker's memory |
| Prompt injection that tries to widen scope | Page text is returned under an "untrusted" heading, separate from trusted fields; an injection guard limits what runs on pages that address an agent; instructions cannot add origins, raise levels or remove forbidden labels (`policy` only adds restrictions) |
| Other web pages talking to the daemon | Daemon bound to loopback; clients authenticate with a bearer `client-token` and the extension with a pairing secret exchanged over native messaging (host manifests allow only the FAI extension ID); neither appears in the popup, logs or results |
| Unverified "done" claims | A result is verified only when an expectation passed in the page (`status: completed`, `verification.passed`) |
| Runaway agents | Per-request call and time budget, pause/stop in the extension, single active lease |

### What FAI does **not** protect against

Read these before relying on FAI for anything sensitive.

- **Prompt injection inside what you allowed.** FAI limits the *blast radius* (origins, level, Approve gate), not the
  model's judgment. A malicious page can try to make the agent click, fill or navigate within the tab and level you
  granted, or write misleading text into the agent's context. If you grant Act on a site, an injected instruction can
  cause an Act-level action there. Grant the lowest level that does the job.
- **The host model sees the page.** The redacted digest and screenshots go to your agent's model provider. Redaction
  reduces what they contain; it does not make a page private. With the experimental Jev autopilot the page digest also goes to the Jev provider.
- **Secrets the redactor cannot recognize.** Heuristics, not proof: a short password in plain prose, a value split across
  elements, text drawn on a canvas, text inside images and closed shadow roots are not found. A cross-origin frame is read
  only when its own origin is one you approved (then the same redaction applies inside it); other cross-origin frames are
  never read, so their text is never returned, and screenshots box every cross-origin frame, `<object>` and `<embed>` FAI did
  not read. In Strict mode (or on a secret page) every canvas and code block is boxed too.
  A page that is itself sensitive (a bank statement) is readable at Read level: redaction targets credentials, not personal data.
- **Values you hand the agent.** Anything in `suppliedText` is typed into the page, which can read it. Do not give an agent passwords or codes; use secret handles.
- **The clipboard.** `copy_secret` writes a value to the OS clipboard (after you approve). Other local programs, the agent's shell included, can read the clipboard until something else replaces it. The approval card says so.
- **Secret handles delivered to the wrong place.** A page that reads the field you approved can send the value anywhere. Approve fills only on sites that should have the secret.
- **Local processes and files.** The `client-token` (the bearer token MCP clients and the CLI use) sits in the runtime state
  directory with owner-only permissions, and the pairing secret in the settings directory; any process running as you can read
  them and talk to the daemon. Traces, screenshots and the daemon log are written under the state directory (`artifacts/`,
  `logs/`): redacted, but they hold page text and images of pages you visited. They are pruned automatically (50 runs, 500 MB
  and 7 days by default); delete them yourself if a task was sensitive.
- **Text that the agent or a page supplies on an approval card.** The site, tab title, control label and total come from the
  browser and the page; "Agent says" is the model's own words. All are shown as plain text and marked as unchecked, but a hostile
  page can choose its own control label and a misled agent can write a persuasive reason. Read the card, not the claim.
- **Approval fatigue.** The Approve gate only protects you if you read it. Many prompts in a row, or approving in advance out of
  habit, defeat it. There is no "always allow" by design; deny what you did not expect.
- **Broad host permission.** The extension requests optional access to `https://*/*` (and, on Firefox, the all-sites choice for
  screenshots) so that it can act on whichever site you approve. Granting the browser's all-sites access widens what a compromised
  extension could reach. Prefer per-site grants.
- **Which build you run.** Every build of the extension carries the same manifest `key`, so it has the same extension ID, and the
  native messaging host trusts that ID. A modified or malicious build loaded unpacked under that ID would be trusted by the
  host. Run only builds you made from source or got from the official release or store listing, and keep the checkout you
  run `npm run setup` from under your control.
- **A compromised machine, browser profile or OS account.** The pairing secret sits in the user's settings directory (mode 0600) and in `chrome.storage.local`; anything running as you can read it and talk to the daemon. FAI is not a sandbox against local malware, and the agent's own shell can read files the browser can.
- **Other extensions and the page's own scripts.** FAI's content script runs in an isolated world and the live page is never modified, but a hostile extension with page access sees what the page shows.
- **Firefox gaps.** Without the user opting into all-sites access, Firefox allows no screenshots after the first navigation; the permission prompt for exact origins appears per new site. Snap/Flatpak Firefox cannot run the native host.
- **Your agent's own tools.** A host with a shell, file access or other MCP servers can exfiltrate whatever it has seen. FAI only controls what it hands to the host.
- **Test-site mode.** It removes the guardrails (sign-in, checkout) for origins you listed. Never list a production site.

Details: [docs/guide/safety-model.md](docs/guide/safety-model.md), [docs/guide/secret-redaction.md](docs/guide/secret-redaction.md) and the
reference sections [Guardrails](docs/REFERENCE.md#guardrails), [Approve gate](docs/REFERENCE.md#approve-gate) and
[Secret redaction](docs/REFERENCE.md#secret-redaction).

## For users: staying safe

- Approve requests by reading the card: site, level, reason. Deny what you did not expect.
- Use the lowest level; use a separate browser profile for agent work (`node src/cli.js launch` creates one for Firefox) and do not stay signed in to accounts the task does not need.
- Run setup yourself; never paste a key or the pairing secret into a chat.
- Keep the extension and the package up to date.

## For contributors

Changes to guardrails, the Approve gate, redaction or pairing need tests that show the new boundary and updated drift copies; see [CONTRIBUTING.md](CONTRIBUTING.md#safety-boundaries-that-must-stay-intact).
Never include a real secret in an issue, a fixture or a test: fixtures use fakes built from fragments.
