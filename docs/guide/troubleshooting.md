# Troubleshooting

Start with the service and the extension:

```sh
node src/cli.js daemon status            # running? extension connected? open requests
node src/cli.js daemon logs --lines 50   # JSON lines; never contains keys, secrets or page text
```

Or ask your agent to call `fai_browser_status`. Reference: [REFERENCE.md: The daemon](../REFERENCE.md#the-daemon).

## Setup and pairing

| Symptom | Cause and fix |
|---|---|
| The popup says it is not paired | Click **Pair with the FAI service**. If that fails, rerun `npm run setup` (it reinstalls the native host and restarts the service). The worker retries every 30 s |
| Pairing fails on Firefox from Snap or Flatpak | The sandbox cannot start the native host. Run `node src/cli.js pair` and paste the secret under popup, Advanced, Connection |
| Pairing fails after loading the extension on a new browser | Setup installs the host for browsers it finds. Install the browser first, then rerun `npm run setup`, or `node src/cli.js install-native --all` |
| Extension ID mismatch (a re-keyed manifest) | `npm run setup -- --extension-id <id>` |
| `daemon_unreachable` / `connection refused` on port 4318 | `node src/cli.js daemon restart`. Another process on the port? Set `FAI_DAEMON_PORT` |
| Agent does not see the tools | Restart the agent after setup. `node src/cli.js install --host claude|codex|opencode` registers it; `--dry-run` shows what it would write. In Claude Code run `/mcp` |

## Approvals

| Symptom | Cause and fix |
|---|---|
| Nothing to approve / the agent says `needs_user` `select_tab` | You did not approve within the wait (default 60 s). Click the FAI Browser icon on the page that opened (pin the icon first), then ask the agent to continue. A request for Act or Test site shows the FAI Browser window first |
| The approval window did not appear | Popup, Advanced: **Show a window when an agent asks** and **Open requested pages right away** must be on; otherwise look for the `?` badge on the icon |
| Chrome asks to allow the site | Domain-root requests (`*.example.com`) trigger Chrome's site-access prompt. Allow it, or have the agent ask for the exact origin |
| The agent asks for a higher level | `needs.level` in the result: approve the new request, which is preselected at that level. Or lower the task |
| `approval_pending` after an Approve-gate request | You did not click **Approve once** in time. The agent repeats the same act; the request waits 5 minutes |
| Deny / `refused_action` | By design: the agent must tell you, not retry. Ask it to do it another way, or do it yourself |
| `stale` / "revision spent" | The page changed or the revision was used already. The agent should `fai_browser_observe` and choose again |
| A purchase button is "refused", not "asks the user" | Approve gate is off (popup, Permissions), or you are below the level that offers it. With the gate on, purchases ask |
| Session pauses with `origin_changed` | The tab left the approved origins (or, on Firefox, `activeTab` ended at the first navigation and you declined the origin prompt). With a toolbar-icon approval, Chrome also withdraws access when it shows its own error page (an HTTP error without a page, an unreachable site). Approve again; approving in the request modal (browser site access) keeps the session through such errors |

## Pages and actions

| Symptom | Cause and fix |
|---|---|
| Empty digest or an expected control is missing | `fai_browser_observe` with a sharper `task` or `focus` and a larger `digestChars` (up to 6000); `moreActions` counts unlisted actions. As a last resort `returnImages: "final"` and a `point` click |
| `controls_capped:<n>` warning | More controls than the offer cap (40 at Read and Use-reversible, 80 above); observe with a sharper task |
| Page shows `[secret:N ...]` where you need the text | Redaction is always on. Add the origin under Secret redaction, **Relaxed origins** (known formats only) for a docs site, or use [secret handles](secret-redaction.md#secret-handles) to move a value |
| A secret was *not* redacted | See [limits](secret-redaction.md#limits). Report: private advisory if it is a live credential, else an issue with a fake value |
| No screenshot on Firefox | Expected after the first navigation: enable Access your data for all websites ([firefox.md](firefox.md)) |
| Screenshot is blank or boxed everywhere | A secret page, Strict mode, or a canvas/frame on the page. Intended; see [secret-redaction.md](secret-redaction.md) |
| Cookie dialog blocks the page | Reject is clicked first at every level. Below Act an accept-only dialog comes back as `relay` for you |
| Login wall (`needs_user` `login`) | FAI never signs in outside Test site. Sign in yourself in that tab, then ask the agent to continue |
| `expectation_failed` / `unverified` | The final page did not match the expectation. Check it against the real URL/text (it is matched on redacted, settled text); loosen it |
| `budget_exhausted` / call budget | Each request allows 50 calls / 20 minutes by default (popup, Advanced, Per-request budget raises the ceiling) |
| `error_page` | The page returned an HTTP error; the agent should stop and tell you |
| `error_page` or the `browser_error_page` warning on the approved site | The browser shows its own error page: the server answered with an HTTP error and no page, or could not be reached. The tab stays approved; once the site is back the agent can reload it (`nav: "reload"`) or open another approved URL |

## Tests and development

| Symptom | Cause and fix |
|---|---|
| Tests kill your terminal / out-of-memory | Run browser-backed tests one file at a time inside a memory cap: [CONTRIBUTING.md](../../CONTRIBUTING.md#running-the-tests) |
| Browser tests cannot find Chromium | Set `CHROMIUM_PATH` to a Chromium/Chrome binary |
| Observe-speed or PNG tests fail only under load | Load, not a regression: rerun that file alone |
| A daemon from an old run interferes | `node src/cli.js daemon stop`; tests use their own `FAI_HOME` and port |

## Still stuck

Collect `node src/cli.js daemon status`, the last log lines and the exact `next.text` the agent saw (all free of secrets), then open a **Bug
report**. For a specific website use the **Site compatibility** template. Security problems: [SECURITY.md](../../SECURITY.md).
