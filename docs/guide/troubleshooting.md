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
| Windows flicker, the agent cannot hold a tab, `daemon status` shows `extension_flapping` | Two installs keep taking the FAI connection from each other. Before 0.6, any two paired browsers did this (issue #9): update both the service and the extensions (Firefox gets the signed add-on update; reload the unpacked one). Since 0.6 several browsers stay connected side by side (`daemon status` lists them under `extension.browsers`). Two legacy Chromium-family builds of the same unpacked extension (0.5.0 or older, in two browsers) still look like one browser and can flap; update them |
| The popup says "Another copy of this browser profile took the FAI connection", or status shows `extension_duplicate_identity` | Two installs share one browser identity, such as a copied browser profile. They do not loop: the one that connected last keeps the connection, and the other takes it back only when you open its popup or after five minutes. Remove the extension from one copy, or reinstall it there for a new identity |
| The popup says "The FAI service refused this browser's id", or status shows `extension_identity_refused` | The service remembers which extension each browser id came from (`browsers.json` in its state directory), and this one claimed an id another extension install had. The extension already picked a new id once by itself. Open the popup to try again; if it keeps happening, stop the service, delete `browsers.json` (it only holds ids and times) and reinstall the extension. A connection you do not recognise is not that browser |
| A request shows as **In another browser** | Several browsers are paired and the request waits in the one you used FAI in last (or the one the agent named). Click **Open here** to move it to this browser |
| Agent does not see the tools | Restart the agent after setup. `node src/cli.js install --host claude|codex|opencode` registers it; `--dry-run` shows what it would write. In Claude Code run `/mcp` |

## Approvals

| Symptom | Cause and fix |
|---|---|
| Nothing to approve / the agent says `needs_user` `select_tab` | You did not approve within the wait (default 60 s). Click the FAI Browser icon on the page that opened (pin the icon first), then ask the agent to continue. A request for Act or Test site shows the FAI Browser window first |
| Approve does nothing, or the agent says to use the toolbar icon | The last approval attempt did not complete (the browser's site-access prompt never showed or was not answered within 45 s, the page had not loaded, the popup closed). Click the FAI Browser icon on the task tab once it shows the site. `daemon logs` has an `approval` line per surface and attempt with its reason (`site_access_timeout`, `page_not_loaded`, ...); no line after your click means it never reached the service ([Approval events](../REFERENCE.md#approval-events)) |
| The agent says you declined site access | You declined the browser's site-access prompt, so nothing was approved. Approve again and allow site access only if you want the task to go on |
| The approval window did not appear | Popup, Advanced: **Show a window when an agent asks** and **Open requested pages right away** must be on; otherwise look for the `?` badge on the icon |
| Chrome asks to allow the site | Domain-root requests (`*.example.com`) trigger Chrome's site-access prompt. Allow it, or have the agent ask for the exact origin |
| The agent asks for a higher level | `needs.level` in the result: approve the **agent asks for more** card on the same task (its level is preselected); the task keeps its tab and page. Or lower the task |
| `approval_pending` after an Approve-gate request | You did not click **Approve once** in time. The agent repeats the same act; the request waits 5 minutes |
| Deny / `refused_action` | By design: the agent must tell you, not retry. Ask it to do it another way, or do it yourself |
| `stale` / "revision spent" | The page changed or the revision was used already. The agent should `fai_browser_observe` and choose again |
| `line_break_input` | A fill with a line break was aimed at a single-line field, where Enter would submit the form. The agent fills without the line break, then submits with `submit_field` |
| A purchase button is "refused", not "asks the user" | Approve gate is off (popup, Permissions), or you are below the level that offers it. With the gate on, purchases ask |
| Session pauses with `child_tab` or `tab_changed` | The page opened a tab or window (with **One task tab**), or another tab came to the front in the task window. Close or use that tab, return to the task tab and click **Resume**. For pages that open tabs, turn on **Multiple task tabs** (Advanced, Tab access), then Pause and Resume. An agent that cannot explain a result can call `fai_browser_guide` (topic `tabs`, `states`, or `{code: "child_tab"}`) |
| The agent's first result says the versions differ | The MCP server, the service and the extension come from different releases and may behave unlike the docs. Update (popup **Update**; in a checkout also `node src/cli.js update`), reload the extension and start a new agent session |
| Reporting a bug | Ask the agent for what `fai_browser_guide` topic `troubleshooting` lists: request and run ids, each result's status, code and next, `fai_browser_status`, the act's trace, and `daemon logs` lines for those ids |
| Session pauses with `origin_changed` | The tab left the approved origins (or, on Firefox, `activeTab` ended at the first navigation and you declined the origin prompt). With a toolbar-icon approval, Chrome also withdraws access when it shows its own error page (an HTTP error without a page, an unreachable site). Approve again; approving in the request modal (browser site access) keeps the session through such errors |

## Invites and wakes

See [REFERENCE.md: Invites and wakes](../REFERENCE.md#invites-and-wakes).

| Symptom | Cause and fix |
|---|---|
| The popup lists no agent under **Invite an agent to this tab** | No `fai-browser-mcp` is registered: the agent was started before the FAI service, or runs an older FAI Browser. Restart the agent (or wait up to 30 s: the server retries), and check `fai_browser_status` shows `agent session: ses_…`. `FAI_MCP_REGISTRY=0` turns registration off. **Invite agent** still works: paste the line it shows into your agent |
| A Claude Code session is listed with "you paste a line" (wake `none`) | The MCP server was not started by Claude Code directly (an `npx` or shell wrapper in the MCP entry), so FAI cannot prove the messaging socket is this session's and does not use it. Reinstall with `node src/cli.js install --host claude` (it writes the node command directly), or paste the copy line |
| The agent says `invite_for_another_session`, `invite_not_joined` or `not_owner` | The invite was made for another agent session, or this one is trying to use an invited tab it did not join. Invite this agent from the popup (its own row), or use the copy line |
| A Codex or OpenCode session shows "not ready: ask it to run any FAI command" | Codex names its thread, and FAI's OpenCode plugin its session, only on a tool call. Ask it to run `fai_browser_status` once; the row is then one tap |
| "Could not wake …" and a **Tell your agent: join FAI invite inv-…** line | The wake failed: copy the line into the agent. The reason is in brackets: `no_socket` (a `--bare` Claude Code session, or one older than 2.1.224; the token needs 2.1.228), `refused` (see the next row), `unknown_thread` (Codex does not know the thread: it was started with another `CODEX_HOME`, or ended), `no_codex` (no `codex` on the MCP server's `PATH`: set `FAI_CODEX_BIN`), `not_polling` (the agent session froze or ended) |
| "Sent to …" but Claude Code does nothing | Its `crossSessionInbound` setting holds or refuses messages from other processes (a repository or managed setting can impose it), or the session bypasses permission prompts. FAI cannot tell: Claude Code's socket answers nothing either way, so "Sent" means written, not received. Claude Code shows a held message for you to accept; set `crossSessionInbound` to `accept` in your Claude Code settings, or tell the agent `join FAI invite inv-…` (the id is in the popup's invite card and in `fai_browser_status`). A session busy with a turn takes the invite when that turn ends |
| The agent says the invite expired, was used or was revoked | An invite lives 10 minutes, is used once, and ends when the tab closes or leaves its site before an agent joined. Invite again from the popup |
| After Resume the agent did not continue | Only the session that made the request is woken, and only Claude Code (with its messaging socket), Codex (after its first FAI call) and OpenCode 1.19 to 1.x (with FAI's plugin, after its first FAI call). Tell the agent to continue; it calls `fai_browser_observe` with the requestId |

## Pages and actions

| Symptom | Cause and fix |
|---|---|
| Empty digest or an expected control is missing | `fai_browser_observe` with a sharper `task` or `focus` and a larger `digestChars` (up to 6000); `moreActions` counts unlisted actions. As a last resort `returnImages: "final"` and a `point` click |
| `controls_capped:<n>` warning | More controls than the offer cap (40 at Read and Use-reversible, 80 above); observe with a sharper task |
| Page shows `[secret:N ...]` where you need the text | Redaction is always on. Add the origin under Secret redaction, **Relaxed origins** (known formats only) for a docs site, or use [secret handles](secret-redaction.md#secret-handles) to move a value |
| A secret was *not* redacted | See [limits](secret-redaction.md#limits). Report: private advisory if it is a live credential, else an issue with a fake value |
| No screenshot on Firefox | Expected after the first navigation: enable Access your data for all websites ([firefox.md](firefox.md)) |
| Content inside a frame is missing; `cross_origin_frame` warning (portals such as the Entra admin center or Azure portal) | The frame comes from another origin the request does not list (`frames` names it, `reason: "not_approved"`). Ask the agent to request it in `origins`, then approve. `no_access`: the request lists it but the browser gives FAI Browser no access (a toolbar-icon approval covers the tab's own site only): approve from the request window, which asks the browser for every origin of the request. See [Frames](../REFERENCE.md#frames) |
| Session pauses with `child_tab` when the page opens a window | The page opened a tab or window (a sign-up flow on another host, for example). The result's `childOrigin` names its origin when the browser shows it; ask for that origin in the next request, or approve with Multiple task tabs if it is on an approved origin |
| Approve or Resume went to an older request | Update FAI Browser: each click now names its request, new requests are listed first and apart from paused tasks, and a stale paused task is folded under Older paused tasks. Release (or let the agent release) requests that are no longer needed |
| Session pauses with `origin_changed` during sign-in | The sign-in went through a host the request does not list; the result's `leftOrigin` (and status) names it. Ask for that origin in the next request |
| Screenshot is blank or boxed everywhere | A secret page, Strict mode, a canvas, or a cross-origin frame FAI did not read (always boxed). Intended; see [secret-redaction.md](secret-redaction.md) |
| Cookie dialog blocks the page | The agent clicks the offered reject button, from Use (at Read it asks you to approve Use). An accept button is only offered at Act: with an accept-only dialog below Act, close it yourself |
| Login wall | FAI never offers sign-in controls or password fills outside Test site. Sign in yourself in that tab, then ask the agent to continue |
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
