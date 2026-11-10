# FAI Browser: improvement proposal

> Note: the experimental Jev autopilot (TypeSafe provider, `fai_browser_run`, step lists, site profiles) this document describes was removed in Unreleased (after 0.6.2). Kept as history.

Status: proposal for approval, 2026-10-03. Synthesized from three code reviews (runtime loop, extension, agent surface) and four research passes (Chrome MV3, MCP tool design, host integration, decision providers). Line references are to the prototype as it was before Phase 1. Phases 1 and 2 are implemented (see "What changed in Phase 1" and "What changed in Phase 2" at the end); Phases 3 and 4 are not. ARCHITECTURE.md describes the current system.

## 1. Where we are

The prototype works end to end and all 23 tests pass. The architecture is right: the host agent delegates a bounded task, a cheap provider picks from offered actions, the extension executes in a user-selected tab, and completion is only `completed` when an independent expectation passes. No other browser MCP server returns a verified outcome plus a replayable trace. That is the product.

Three things stop it from being usable by an agent today, and a fourth makes it slow.

1. **An agent cannot drive it.** The CLI blocks on a readline "press Enter" prompt. With stdin closed it hangs forever. With Enter piped in it consumes the keystroke before the human can click and returns `needs_user` with exit code 0. Each command starts a fresh companion, so every task costs the user another "Select tab and start" click. There is no MCP server and `serve` exposes no run API.
2. **Results are not agent-readable.** `trace.json` embeds every screenshot as base64 (80 KB for a one-action run; megabytes for real runs). Stdout mixes prose with pretty-printed JSON. `needs_user` and `needs_host` exit 0. A single `step` can never verify because the loop breaks before the done check. The annotated footer names the pre-action target while the boxes show post-action controls, so "click #1" labels the wrong element.
3. **Recoverable errors kill the lease.** Any extension error, including a plain stale revision or a cross-origin link, flips the lease to paused and forces the user to reselect the tab. Pause and Stop both end the run. Stop surfaces as `needs_user`, not `stopped`.
4. **The loop spends most of its time waiting on nothing.** Measured per step in headless Chromium with a zero-latency provider: about 1.5 s for execute plus 250 ms per observe round trip. The real browser trace shows 975 ms for one step with a 1 ms provider. Sources, all fixed waits:

| Wait | Where | Cost per step |
|---|---|---|
| 250 ms command poll, two or three commands per step | `background.js:77`, `bridge.js:43` | 250-500 ms |
| Runtime "freshness" observe before execute, duplicating the atomic check in `page.js:31` | `runtime.js:90` | 125-250 ms |
| Fixed 250 ms settle after every action, including scroll and fill | `background.js:43` | 250 ms |
| Capture throttle to 550 ms spacing | `background.js:26` | 0-550 ms |
| Three extra observes and two script injections around capture | `background.js:17-34` | 50-100 ms |
| Offscreen PNG encode (1 s in headless, small in headed; unexplained) | `offscreen.js:10` | 0-1000 ms |
| Final `done` decision plus a second observe even when the expectation is already met | `runtime.js:82-88` | 0.5-1.2 s per run |

Target after this proposal: per-step time of roughly provider latency plus 150 ms. With Jev that is about 0.5-0.9 s; with a local Kev or Decider 4B it is about 0.2-0.4 s.

## 2. Target architecture

```text
Claude Code / Codex / OpenCode / scripts
   │ MCP stdio            │ CLI              │ SDK
   └──────────────────────┴──────────────────┘
                      thin clients
                           │ loopback client API (unix socket or 127.0.0.1 + client token)
                   ┌───────┴────────┐
                   │ fai-browser    │  long-lived, auto-started by any client
                   │ daemon         │  owns: companion, leases, pending tab requests,
                   │                │  runs, traces on disk, provider config, Jev key
                   └───────┬────────┘
                           │ WebSocket, pairing secret, Origin check
                   ┌───────┴────────┐
                   │ Chrome ext     │  side panel, badge, approvals, pause/resume/stop
                   └───────┬────────┘
                           │ scripting, activeTab grant from user click
                        selected tab
```

Decisions this implies:

- **Daemon, not per-process.** The daemon holds the tab lease across agent calls, so a user approves a tab once per task, not once per command. Clients auto-start it if it is not running (gpg-agent pattern). Single instance per user, lock file, loopback only. The Jev key moves out of each client's environment into the daemon.
- **WebSocket push to the extension.** Replaces the 250 ms poll. A 20 s ping keeps the MV3 worker alive on Chrome 116+, which the manifest already requires. The extension stays connected between runs so it can show pending tab requests. Long-poll is the fallback if the socket fails.
- **Two-phase tab approval.** `request_tab` returns immediately with a request id. The user approves in the extension. Clients `wait` in bounded calls (45 s or less) because Codex's default MCP tool timeout is 60 s. No single blocking call.
- **Tab grant stays user-initiated.** The agent has no access to any tab or the browser until the user selects a tab in the extension for that request. Use the `activeTab` grant from the user's click; do not add optional host permissions or any "remember this site" mechanism. Narrow `host_permissions` away from all of `127.0.0.1`, which currently makes the manual activeTab check meaningless.
- **Generic client API.** The client API must stay generic (plain loopback HTTP/JSON plus a small SDK) so the daemon can be spliced into other agentic products beyond Claude Code, Codex and OpenCode.
- **Provider optional.** Add an observe-only call that returns the compact observation plus offered actions, and an `act` call that executes a host-chosen action id. A strong host model can take over on hard steps; the cheap provider handles routine ones. This also makes the whole thing testable without any provider.

## 3. The loop

Ordered by gain per effort. Items 1-6 need no architecture change and can land first.

1. **Check the expectation after every executed action and finish early.** Today it is checked only when the provider says `done`, and the loop breaks on the action budget before that decision can happen, so a task needing exactly N actions never completes. Checking post-action removes the final provider call and the extra observe. (`runtime.js:82-105`)
2. **Drop the pre-execute freshness observe.** The page script already rejects a stale revision atomically. Return a structured `stale` error from the extension, re-observe, and let the provider decide again, without pausing the lease. (`runtime.js:90`, `page.js:31`, `background.js:49`)
3. **Action-aware settle.** Navigating actions: wait for `tabs.onUpdated` status complete (cap 3 s), then two animation frames, then 100 ms of mutation quiet (cap 1.5 s). Non-navigating actions: two frames plus 50 ms quiet, cap 300 ms. `wait` sleeps 500 ms. Record the settle reason in the event. (`background.js:43`)
4. **Capture off the critical path.** Execute returns the observation as soon as the page settles. Capture, annotate and deliver the screenshot as a follow-up bound to the same revision while the next provider call is in flight. Add `capture: "each" | "last" | "none"`, default `each` for step and `each` for run with the async path. JPEG at quality 70, downscaled to 1280 px wide. Screenshots are meant to speed the host agent: return a downscaled JPEG per step so the host can act on evidence without a separate call. The daemon/CLI must enforce automatic retention, with defaults of keep the last 50 runs, 500 MB total, 7 days age, pruned on every run write, configurable and documented. Fix the offscreen encode (sync canvas or worker) and measure it in headed Chrome. (`background.js:25-44`, `offscreen.js`, `runtime.js:96`)
5. **One injection, one assertion, one observe per command.** Inject `page.js` once per document id. Call `assertTab` once per command. Do a single revision check around capture. (`background.js:17-34`)
6. **Semantic revision.** Hash url, text, control labels and ids. Exclude bounds and attribute-only mutations so spinners, tickers and scroll do not invalidate every decision. (`page.js:5,17,26`)
7. **Push transport.** WebSocket as above. Re-dispatch immediately after a result instead of waiting for the next tick. (`bridge.js:43`, `background.js:46-52,77`)
8. **Provider payload and reliability.** Dedupe labels between `controls` and `criteria` (criteria reference the control: `"3 link About"`). Drop `revision` from the payload. Send page text from the visible region, not the top 8000 chars. Never put supplied form text in action descriptions or history. Warm the TLS connection while waiting for the lease. Retry once on 429, 5xx and network errors. Accept responses without `usage` and with extra fields so Kev and Decider work. Record `x-typesafe-request-id`, `latency_ms`, confidence and probabilities in the trace. (`typesafe.js`, `runtime.js:17,25,28`)

## 4. Correctness fixes

All verified by the reviews unless marked inferred.

- Budget bug: a run needing exactly `maxActions` actions cannot complete. Fixed by item 3.1.
- Role mapping: checkboxes, radios and `input[type=button]` become `textbox`, so they are offered for fill and never for click. (`page.js:15`)
- Risk regex is unanchored and applied to links: "Savings", "Payments", "Resend" become destructive and vanish from both policies. Use word boundaries and apply the destructive class to buttons, not links. (`page.js:16`, `runtime.js:4`)
- The 250-action cap drops scroll, wait and navigate on busy pages. Reserve slots for them. (`runtime.js:25`)
- Reversible mode offers off-origin links that the page script then refuses, which pauses the lease. Offer only the lease origin. (`runtime.js:13`)
- Status taxonomy: successful `step` reports `stopped`; budget exhaustion reports `stopped`; user Stop reports `needs_user`. See the result schema below.
- Expectations: validate up front, case-insensitive text match, add `textAbsent`, `urlMatches` regex, and `changedSinceStart`. Guard against undefined text. (`runtime.js:33-38`)
- Cancellation: an aborted command still executes in the extension and its side effect is dropped from the trace. Record the action before capture, and report `stopped` with the partial event.
- `onAction` throwing or being slow fails or stalls the run. Fire-and-forget by default.
- CLI: `companion.close()` not in `finally`; EADDRINUSE on the fixed port crashes; `.env.local` and `artifacts/` resolve against cwd so the CLI breaks when invoked from another project.
- Child tabs: a same-origin `target=_blank` click succeeds and then kills the run. Block it in the page script and offer it as a handoff instead.
- Types drift: `Observation` lacks `viewport`, `Decision` lacks `model`, CLI-only options are untyped.
- Test gaps: nothing exercises `cli.js`, `page.js` or `background.js` beyond the smoke script; no integration test for runtime plus bridge; none of the bugs above have a test.

## 5. Agent-facing result and trace

One lean JSON object across CLI stdout (one line) and SDK return; MCP renders a complete readable text result instead of mirroring it in `structuredContent`. Screenshots live on disk and are referenced by absolute path; the trace never embeds base64.

```json
{
  "v": 1,
  "runId": "uuid",
  "status": "completed | unverified | checkpoint | budget_exhausted | needs_user | needs_host | stopped | failed",
  "reason": "human-readable",
  "code": "machine code, e.g. select_tab | login | cross_origin | child_tab | stale | provider_error",
  "needs": { "who": "user | host | none", "message": "what to do next" },
  "verification": { "checked": true, "passed": false, "expectation": { "urlIncludes": "/about" } },
  "page": { "url": "", "title": "", "textExcerpt": "first 2000 chars", "truncated": true,
            "controls": [ { "ref": "3", "role": "link", "label": "About", "href": "" } ] },
  "steps": [ { "i": 1,
               "action": { "type": "click", "ref": "2", "label": "About project", "fromUrl": "", "toUrl": "" },
               "decision": { "by": "provider | host", "actionId": "a0", "confidence": 0.97, "model": "jev-latest" },
               "ms": { "decision": 312, "settle": 140, "capture": 60, "total": 540 },
               "settle": "load_complete | quiet | cap",
               "screenshot": "/abs/path/1.jpg", "changed": true } ],
  "cost": { "provider": "jev-latest", "decisions": 3, "inputTokens": 2400, "outputTokens": 27, "elapsedMs": 1900 },
  "trace": "/abs/path/trace.json"
}
```

Exit codes: 0 for `completed`, `unverified`, `checkpoint`; 2 for `needs_user`, `needs_host`, `budget_exhausted`, `stopped`; 1 for `failed`. Diagnostics go to stderr. Page-derived text is always under `page` and `textExcerpt`, never in `reason` or `needs.message`, so a skill can tell the agent which fields are untrusted.

## 6. MCP server and distribution

Tool set, prefixed to avoid collisions with Playwright and DevTools servers. All read-only-annotated except `run`, `step` and `act` in reversible mode.

| Tool | Params | Returns |
|---|---|---|
| `fai_browser_status` | none | daemon, extension, lease, pending requests, active run |
| `fai_browser_request_tab` | `origins[]`, `reason`, `mode` | `requestId`, immediately |
| `fai_browser_wait` | `requestId` or `runId`, `maxMs` ≤ 45000 | `pending | ready | done` plus the result when done |
| `fai_browser_run` | `instruction`, `maxActions`, `maxMs`, `expectation`, `suppliedText`, `capture`, `returnImages` | result schema; final annotated image as an image block |
| `fai_browser_step` | same, one action | result plus image |
| `fai_browser_observe` | none | compact page plus offered actions, no execution |
| `fai_browser_act` | `actionId`, `expectedRevision` | result of one host-chosen action |
| `fai_browser_stop` | `runId?` | status |
| `fai_browser_evidence` | `runId`, `step?`, `kind` | screenshot image block or trace text |

Behaviour: progress notifications per action (Claude Code resets its idle timer on them; other hosts ignore them). Server-side `maxMs` enforced regardless of host timeout. `isError` only for bad params or a missing daemon; task outcomes go in `status`. Images default to one downscaled JPEG per call; `returnImages: "none"` for text-only hosts. Observe and act are not gated; the skill tells the agent when to observe versus act, and this is use-at-your-own-risk by design.

Distribution: one npm package with two bins, `fai-browser` (CLI and daemon) and `fai-browser-mcp` (stdio server). A `fai-browser install --host claude|codex|opencode` command writes the host's config snippet. One `SKILL.md` under `skills/fai-browser/` carrying the current AGENTS.md policy, exposed at `.agents/skills/` (Codex, OpenCode) and `.claude/skills/` (Claude Code, OpenCode). Plugin manifests for Claude Code and Codex are optional polish later; OpenCode has no bundle format.

Host config, verified against current docs:

```json
// Claude Code .mcp.json
{ "mcpServers": { "fai-browser": { "command": "fai-browser-mcp", "timeout": 600000 } } }
```
```toml
# Codex ~/.codex/config.toml
[mcp_servers.fai-browser]
command = "fai-browser-mcp"
tool_timeout_sec = 120
```
```json
// OpenCode opencode.json
{ "mcp": { "fai-browser": { "type": "local", "command": ["fai-browser-mcp"], "enabled": true } } }
```

## 7. Human UX

Replace the popup with a side panel (Chrome 114+). Keep the toolbar action as the opener.

- **Pairing once.** Pin the extension ID with a manifest `key` so it is stable and setup no longer asks the user to copy it. The daemon prints one pairing code; the panel's setup view takes that single string. Native Messaging would remove pairing entirely but needs a per-OS host manifest, so defer it.
- **Pending request.** When an agent calls `request_tab`, the badge shows `?` and the panel shows a card: the instruction, the requested origins, the current tab, and one button, "Approve this tab". Whether a side-panel button click grants `activeTab` is unverified and must be tested; the fallback is the toolbar action click as the gesture. Mismatched origin is explained in place, with the approved list shown.
- **Live run view.** Latest annotated screenshot thumbnail, step list with action and settle reason, elapsed time against budget, provider name. Updates come over the socket; the panel listens to `storage.onChanged` so it is never stale.
- **Real pause.** Pause holds the queue and keeps the lease and run identity in `storage.session`. The user can take over the tab, then press Resume; the runtime re-observes and continues. Stop ends the run and reports `stopped`.
- **Handoffs in place.** Login, MFA, cross-origin and child-tab handoffs show as a card with "I've handled it, continue". The agent sees `needs_user` with a code and the same message.
- **Completion.** The panel shows the verdict and a link to the trace folder. Traces contain page text and supplied data; say so in the panel.
- **Tab in its own window.** Optional: let the user pop the leased tab into a separate window so they keep working elsewhere. `assertTab` is already window-scoped. Capture of an occluded window needs testing.

## 8. Providers and evaluation

- Make `LocalSystemOneProvider` tolerant (optional `usage`, extra fields, configurable port: Kev uses 8009, Decider 8000, longer cold-start timeout).
- Experiment: move `done` and `handoff` out of the click distribution into two `noul` yes/no questions in the same request. The API supports several named questions. Evaluate before adopting.
- Use confidence and probabilities for a handoff threshold, calibrated on fixtures.
- Build a benchmark harness from the existing `browser-smoke.mjs`: Playwright launches Chromium with the extension, fixture server, deterministic provider, reports p50 and p95 per-stage timings. Run it before and after each loop change. Later add the same fixtures through Playwright MCP as the baseline the architecture doc promised.
- Evaluate Kev 4B and Decider 4B on the fixture set once the harness exists. Both fit 8 GB and answer in tens to hundreds of milliseconds; click accuracy is untested.

## 9. Phases

**Phase 1: loop and correctness, no new architecture.** Items 3.1-3.6, 3.8, section 4, section 5 result schema and lean trace, remove the Enter prompt in favour of waiting on the lease, exit codes, benchmark harness. Measurable: per-step time and the fixed bugs. Everything stays testable with the fake bridge and provider.

**Phase 2: daemon, push transport, MCP, skill.** Daemon with client API and auto-start, WebSocket transport, CLI as thin client, MCP server with the tool set above, `SKILL.md`, `install --host`, two-phase tab request.

**Phase 3: extension UX.** Side panel, pending-request badge, activeTab approval gesture test, real pause and resume, pinned extension ID, in-place handoff cards.

**Phase 4: providers and evaluation.** Local model eval, multi-question experiment, confidence gating, Playwright MCP comparison.

Phases 1 and 2 are independent enough to run in parallel if the result schema is fixed first.

## 10. Decisions (2026-10-03)

1. Daemon with auto-start: approved.
2. Tab grant stays user-initiated via `activeTab`; no remembered site permissions.
3. WebSocket now, Native Messaging later: approved.
4. Per-step screenshots by default, async, with retention: approved.
5. Observe/act tools included and ungated: approved.
6. Phase order: approved.

Testing may use Codex agents run from the terminal.

## What changed in Phase 1

Phase 1 landed on 2026-10-03: items 3.1-3.6 and 3.8, the section 4 fixes, the section 5 result schema and lean trace, the Enter prompt replaced by waiting on the lease, the exit codes, automatic retention, host-driven `observe()`/`act()` in the SDK, the pinned extension ID with narrowed `host_permissions`, and the benchmark harness. The transport is still the HTTP long-poll; WebSocket push stays in Phase 2. ARCHITECTURE.md describes the current system.

Measured in Chromium with the shipped extension:

| Metric | Before | After |
|---|---|---|
| Headless per-action time (execute until observation) | ~1.5 s | 55-160 ms |
| Observe round trip | 150-250 ms | ~7-13 ms |
| Offscreen JPEG encode per frame | 1007 ms (`convertToBlob`) | 5 ms (DOM canvas `toDataURL`) |
| Real-browser bench, total per step, zero-latency provider, `capture: each` | 975 ms (one-step trace) | 516 ms p50 |

With `capture: each` the step rate is now bounded by Chrome's `captureVisibleTab` quota: the extension spaces screenshots 500 ms apart. `capture: last` (actions run uncaptured, then one on-demand capture of the final step) and `capture: none` lift that ceiling to about 166 ms per step with a zero-latency provider. With 400 ms of provider latency the total per step is about decide plus execute (567 ms p50): the screenshot is captured while the provider decides and adds nothing.

## What changed in Phase 2

Phase 2 landed on 2026-10-04: the daemon with its loopback client API and auto-start, the WebSocket push transport (with the long-poll kept as a fallback), the CLI as a thin client, the MCP server with the ten tools of section 6, `SKILL.md`, `install --host claude|codex|opencode`, and the two-phase tab request (request, then the user's "Approve this tab" click). ARCHITECTURE.md describes it; the Phase 2 design document governed where it and section 6 differ.

Differences from section 6 and the design:

- **Claude `.mcp.json` has no `"timeout"`.** Every tool call is bounded at 45 s (`FAI_MCP_MAX_CALL_MS`), so the key is not needed. The Codex block keeps `tool_timeout_sec = 120` and adds `default_tools_approval_mode = "approve"`, which `codex exec` requires (verified with the benchmark harness).
- **`install` writes absolute paths** (`node` plus `src/mcp-main.js`), because the package is private and its bin is not on `PATH`. `--command-name` writes the bare `fai-browser-mcp`.
- **Pause pauses the lease, not the run.** The run ends as `needs_user/paused`; Resume in the popup grants a new lease and the agent starts a new run. Keeping the run alive is Phase 3.
- **`--port` always names the daemon port.** The Phase 1 in-process companion now needs an explicit `--in-process`.
- **Confidence floor, ahead of Phase 4.** `minConfidence` (0 to 1, default off) on run and step returns a doubtful provider choice to the host as `needs_host/low_confidence` with the top five alternatives, instead of executing it. Calibrating a default is still Phase 4 work.
- The pending badge is `?` rather than a count; one active lease at a time, and approving another request supersedes it.

Measured:

| Metric | Value |
|---|---|
| Observe round trip, headless Chromium | 4 ms p50 |
| Click action, headless Chromium | 75 ms |
| Navigating action, headless Chromium | 157 ms |
| Agent benchmark, condition B (Codex `gpt-6.1-sol` + FAI MCP), task `about-members`, 1 run | pass, 24.1 s wall, 4 tool calls, 1 Jev decision, 549 ms inside FAI, 410 ms harness approval |

The benchmark's wall time is dominated by Codex itself: its first tool call came 8.6 s after start, and the four tool calls took 0.6 s in total. One run is not a comparison; use `--condition both --repeat 3` before quoting an A/B ratio.

## Efficiency pass (2026-10-04)

The host model's cost is its fixed prefix (system prompt, tool schemas, MCP instructions, task prompt) times the number of model requests. The baseline full pass (`bench/results/2026-10-03T22-35-28-967`, 8 tasks, medians of up to 2 runs) showed FAI ahead on tool calls (30 against 47) but behind on tokens: about 19.6k tokens per request against Playwright MCP's 11.4k, 742k tokens in total against 558k, and 199 s of wall time against 175 s.

The change set, with no daemon change:

- **One-call run.** `fai_browser_run` takes `origins`, `reason`, `requestId` and `answerQuestion`. The MCP server reuses an active, pending or paused request that covers the origins, otherwise creates one, waits for approval within the call budget minus 2 s, then runs with the time left. Unapproved, it returns `needs_user/select_tab` with the `requestId` and a `next` line to call run again.
- **Seven tools** (`status`, `run`, `wait`, `observe`, `act`, `stop`, `evidence`). request_tab, step and release left the MCP surface (they stay in the CLI and SDK); `maxActions: 1` is a step and `stop` with `requestId` releases. No output schemas, one- or two-sentence descriptions, the loop in a 539-character `instructions` string. tools/list fell from 17,279 to 7,334 bytes.
- **Compact results.** The text block is a complete plain summary (status, verification, URL, title, `answer.candidates`, `page.digest`, `needs`, `next`, trace), with no `structuredContent` mirror. `returnImages` defaults to `auto`: no image for a verified success.
- **Skill and bench prompt** teach the one-call path and answering from candidates and digest; the bench reports model requests and priced tokens and merges a baseline directory.

First B-only rerun (`bench/results/2026-10-03T23-01-52-613`, 1 run per task, against the baseline above):

| Condition | Pass | Wall s | Tool calls | Requests | Tokens | Priced |
|---|---|---|---|---|---|---|
| A Playwright MCP (baseline) | 14/14 | 174.7 | 47 | 55 | 558,504 | 163,889 |
| B FAI, before | 13/13 | 198.7 | 30 | 38 | 742,444 | 242,967 |
| B FAI, after | 7/8 | 222.2 | 24 | 32 | 748,267 | 244,203 |

Single-page tasks now take one call and two requests (about-members 35k tokens and 16.3 s, against A's 57k and 21.3 s). Multi-hop tasks did not improve: the provider stopped on an intermediate page whose loose expectation passed, and the host then drove observe and act, whose JSON results (full page text and controls) are large. One `auto` screenshot on an unverified result cost Codex about 25k tokens per later request (slow-content). The per-request prefix is still about 17k tokens. docs-lead-guide failed because the host took the top answer candidate, which the provider ranked without the About-page fact the question depended on. Next levers: a compact observe text block, no automatic image for Codex hosts, provider runs that cover every hop before checking the expectation, and three repeats before quoting ratios.


### Second pass: Jev decides doneness, lean results, no default images (2026-10-04)

The first rerun lost on multi-hop tasks for three reasons, each fixed:

- **Loose expectations stopped runs early.** `TypeSafeProvider.decide` now asks two questions in one SystemOne request: the `action` choice (without `done`; `handoff` stays) and `done`, a `noul` question ("Is the requested outcome of the instruction already visible on this page?", answered as `{type: "noul", noul: p}`). The decision carries `done: {probability}`. A run completes when the expectation passes and done >= `doneThreshold` (0.5, configurable on the SDK, CLI and daemon); a passing expectation with lower done continues. Out of actions with the expectation passing: `completed`/`budget_reached_expectation_passed`. Without an expectation, done >= 0.8 ends the run `unverified`. Two traces showed Jev keeps done low (0.23-0.49) on the last page of a multi-hop task, because the answer combines pages, and chooses `handoff` there; a handoff on a page where the expectation passes is `completed`/`handoff_expectation_passed`. Done above the threshold twice with a failing expectation ends `unverified` instead of burning the budget. Providers without `done` keep expectation-only completion. `LocalSystemOneProvider` inherits the protocol.
- **Fat results.** `agentResult()` (src/result.js) is the one lean shape for CLI stdout and `toAgentResult`, rendered as readable text by MCP: no per-step observations, screenshots, probabilities or bounds; `page.digest` is a list of strings, `textExcerpt` only when the digest is empty, the top three candidates. A 6-step run (fake bridge, catalog-sized pages): agent result 5,224 -> 2,297 B, text block 1,620 -> 1,556 B. Observe returns `{revision, page{url,title,digest}, actions[{id, description}]}` (at most 40, page actions always listed) with a text block of digest lines and `a3  click "About"` lines: 7,074 -> 2,549 B for the same page.
- **Images.** `returnImages` defaults to `none` for run, act and observe; `final` and `all` fetch screenshots through the evidence route.

Two fixes came from reading the first rerun's traces. Multi-hop answers: the runtime keeps the pages it visited and sends up to two well-matching lines per earlier page to `choose()` as `earlierPages` and to the host as `trail` (Jev picked the right docs-lead guide at 0.92 with the About line, 0.12 without). New-tab links: a same-origin `target=_blank` link is offered as navigation to its href in the selected tab, so settings-new-tab no longer needs three retries. The skill, MCP instructions and bench prompt now say that the expectation must identify the final page, that candidates are guesses to check against the digest and trail, and that a run ending on the wrong page is repeated with a sharper instruction rather than observe/act.

B-only reruns against the same baseline (`2026-10-03T23-28-57-538`, 1 run, before the two trace fixes; `2026-10-03T23-35-50-786`, 3 runs, medians):

| Condition | Pass | Wall s | Tool calls | Requests | Tokens | Priced |
|---|---|---|---|---|---|---|
| A Playwright MCP (baseline) | 14/14 | 174.7 | 47 | 55 | 558,504 | 163,889 |
| B, first efficiency pass | 7/8 | 222.2 | 24 | 32 | 748,267 | 244,203 |
| B, second pass, 1 run | 8/8 | 169.4 | 13 | 21 | 347,333 | 97,875 |
| B, second pass, median of 3 | 24/24 | 139.6 | 9 | 17 | 292,657 | 101,590 |

A / B over the median of 3: wall 1.25x, tool calls 5.2x, requests 3.2x, tokens 1.91x, priced 1.61x. Seven of eight tasks take one call and two model requests. The remaining miss is catalog-plan-price (median 2 calls): in two of three runs Jev handed off on catalog page 2 after reading the plan, or went back from Pricing to the catalog, so the host re-ran with "click Pricing". That is navigation quality after reading a fact, not doneness. Priced tokens vary with prompt-cache state (uncached input 4k-13k per task).

## What changed in the oversight pass (2026-10-04)

Design: OVERSIGHT-SPEC.md. Goal: one tool call and two model requests per task, a third only when a receipt says exactly what to decide; preference mechanical > Jev > host > user.

Decisions (user, binding for this pass):

1. The learning loop (spec section 5) and interactive mode (`approvals`) are out. The gate thresholds live in one object (`thresholds`: `linkFloor` 0, `controlFloor` 0.5, `doneThreshold` 0.5, `strongDone` 0.8, `answerConfirm` 0.8, `answerMargin` 0.5) so a later pass can tune them; `config.json` may set them.
2. Login: the system never attempts it. `login` fires only for a password field together with a sign-in title or first heading; a password field alone is a `password_field` warning.
3. The per-request ladder budget is configurable: `maxCalls` (6) and `maxMs` (120000) per `requestId`, per `fai_browser_run` call or in `config.json`; beyond it the MCP returns `budget_exhausted`/`task_budget`.
4. Consent dialogs: reject or necessary-only, never accept, in every mode including read-only. One such button is clicked mechanically (a step with `class: "consent"`), several go to Jev alone, none ends as `needs_user`/`consent_banner`. Cross-origin consent (consent.google.com) is `cross_origin` naming the origin; the skill tells hosts to add it to `origins`.

What shipped:

- **Receipt v2** (`src/result.js`, `v: 2`): `verdict {kind, oversight, answer, why, decide, suggested, budget}` and `next {kind, text}` with nine kinds (`answer`, `answer_from_digest`, `confirm_page`, `choose`, `rerun`, `split`, `relay`, `approve`, `stop`); new codes `expectation_mismatch`, `consent_banner`, `login`, `task_budget`. The status taxonomy and exit codes are unchanged; `reason` stays in the JSON but leaves the text block when `why` exists.
- **Runtime ladder** (`src/runtime.js`, `src/oversight.js`): rung 0 pre-checks on every page, `unsupported` retry with exclusion, the late-navigation re-observe (strong done with a failing expectation, or a quiet/navigated link click on an unchanged URL), a scroll nudge before handoffs, decide options for `choose`, per-class floors (`minConfidence` is now the `controlFloor` alias, so links are no longer gated by it), `suggested.expectation` from the real final path, `suggested.instruction` from the host's unvisited named pages, a `plan.split` hint for joins and 4+-page tasks, a 45 s default timeout for 4+-page instructions, and `terms` on observe for the page script's control ordering.
- **Answers** (`src/digest.js`): intent classifier, shape check, margin, list-aware candidates (the item run under the matching heading is one candidate) and the auto-confirm rule behind `verdict.answer`.
- **MCP** (`src/mcp.js`): call-time expectation lint, the identical-call refusal, the per-request budget, `next` first in the text block and one untrusted heading over page text.
- **Skill and bench prompt**: rules A-E with the verbatim winning examples and the `next.kind` table; the bench prompt is three lines. The bench records oversight rate and false automation (`verdict.answer` graded on its own).

Deliberate deviations from the spec text: `suggested.instruction` never quotes page text (the spec's example copies a trail fact into it; that would launder untrusted text into a trusted field, so `next` tells the host to add the fact itself), and the consent dialog text goes to `needs.dialog` (untrusted) rather than into `next.text`. `expectation_mismatch` maps to `confirm_page` (the spec's 2.3 table) rather than the worked example's `answer_from_digest`. A list question is not auto-confirmed (spec 1.2), though its whole list is now one candidate.

## Jev guidance pass (2026-10-04)

Research: TypeSafe's SystemOne API has no policy or guidance field. The documented pattern is policy text inside `state`, referenced by name from the question; an explicit "other" option; extra `noul` questions in the same request (evaluated independently and in parallel, so nearly free in latency); `what`/`not_for` descriptions for confusable options; and backoff that honours `Retry-After`. Each became a switch in `TypeSafeProvider`'s `guidance` option (`policy`, `handoffOther`, `guards`, `criteria`, `retry`), so each can be measured alone.

**Evaluation.** `EVALUATION.md` is a qualitative comparison of two outside projects and has nothing runnable, so this pass adds a decision-level fixture evaluation. `bench/jev-eval/cases.mjs` has 39 labelled cases: 18 on the benchmark site and 21 adversarial pages in `bench/jev-eval/pages/` (consent dialogs, a consent wall, login wall, captcha, paywall, an error page, four injection pages, confusable pagination/tab/next/version links, a cart). `bench/jev-eval/capture.mjs` records real `page.js` observations into `test/fixtures/jev/cases.json`. `node bench/jev-eval.mjs` sends each case through the runtime's provider boundary to live Jev (the key is loaded the way the daemon loads it and is never printed). It ran 3 repeats per config, 819 requests in total (`bench/results/jev-eval-1/`):

| config | accuracy | false handoff (should act) | false act (should hand off) | p50 ms | p95 ms | input tokens | blocked recall / FP | injection recall / FP |
|---|---|---|---|---|---|---|---|---|
| all off (previous request) | 0.863 | 0.067 | 0.333 | 225 | 303 | 1078 | - | - |
| policy | 0.915 | 0 | 0.259 | 228 | 295 | 1214 | - | - |
| handoffOther | 0.846 | 0.067 | 0.333 | 222 | 276 | 1083 | - | - |
| guards | 0.855 | 0.067 | 0.333 | 224 | 303 | 1121 | 1.00 / 0 | 1.00 / 0 |
| criteria | 0.880 | 0.033 | 0.333 | 221 | 277 | 1105 | - | - |
| retry | 0.855 | 0.067 | 0.333 | 226 | 275 | 1078 | - | - |
| **all on (default)** | **0.949** | **0** | **0.222** | 227 | 338 | 1289 | 1.00 / 0 | 1.00 / 0 |

With all switches off, Jev handed off on both multi-reject consent dialogs (0/3 each) and clicked "Place order" on the cart (0/3). The policy fixes all three. The criteria switch fixes one consent dialog by itself. With all on, the only misses are "Delete my account" (Jev opens Account settings, a plausible read-only step; the delete itself is gated in code) and the 500 page (Jev clicks Home). `handoffOther` alone is within noise (one case, 2 of 3 runs) and helps in combination. Guards add about 200 input tokens and did not move p50 latency. Default: **all on**. Accuracy rises 8.6 points and p50 latency moves +2 ms, inside the +100 ms budget.

**Option order.** `node scripts/jev-order-check.mjs` replays the cases (39 at the time of the run) with options shuffled (handoff kept last) and counts choice flips. With all on: 6 of 117 shuffled requests flipped (5.1%). Five of those flips are between two equally correct consent reject buttons, so correctness flipped in only 0.9%. With all off: 1.7% flipped, all of them correctness flips. Order bias is small, so ordering stays as offered.

**Review follow-ups.** "Place order" was stopped only by the policy, so commit labels are now caught in code (`COMMIT_ACTION`, runtime and page.js, drift-checked); the case set gained a 40th case, an ordinary assistant chat transcript labelled not-injection (a live chat app scored 0.83 on the injection guard, just under the veto; the synthetic page scored 0.38), so a future threshold change is tested against it. The consent redirect follow is one hop per session and recorded as `consent:redirect:<origin>`; with the shipped activeTab-only manifest Chrome drops the grant on the cross-origin hop, so the probe result below (which runs with `<all_urls>`) overstates what an end user sees.

**Real-site consent fixes.**
- booking.com: the Decline click worked, but OneTrust closes the banner a few hundred ms later. The observation after settle (quiet at about 105 ms, since attribute and style changes are not observed) still showed the banner, so the runtime clicked Decline again on the same revision and gave up. Now:
  - a reject counts only after the dialog closes: the runtime re-observes every 250 ms for up to 2 s (`consent:wait`, then `consent:rejected`);
  - the same consent button is never clicked twice;
  - a dialog that stays open is `consent_banner` with `consent:persisted`;
  - page.js ignores a banner at opacity 0.
  The probe now records `consent:wait`, `consent:rejected` and a completed run on the Lisbon results page (variant 1).
- Google Flights: on `consent.google.com`, Reject all and Accept all sit below the fold, so the whole-page check, which only counted in-viewport buttons, found nothing, and Jev handed off. Now:
  - a whole-page consent wall counts any rendered button, so Reject all is the mechanical step;
  - the extension follows the one redirect from a `consent.*` host to an origin the same request approved (the lease reply now carries the request's origins);
  - the run continues on the `continue` URL. The probe reaches the LIS-LHR results, with "from €105" as the top candidate (0.81).
  - If the `continue` origin is not approved, the run returns `cross_origin` naming it without clicking. The probe's `--landing-only` run shows this.
- Expedia (two new probe tasks): both landed on Expedia's "Bot or Not?" wall. The new `blocked` guard scored it 0.95, and the run returned `needs_user`/`blocked` after one decision, where it previously would have handed off or wandered.

## Machinery pass (2026-10-04)

Goal: close the six failure classes the QA corpus (`bench/qa/`) found in `qa-2026-10-04T08-59-59-162Z-full` (58/64, one dangerous choice offered) in code, not prompts. No new extension permissions; the extension ID is unchanged; trusted fields still hold no page text.

1. **Destructive links.** `destructiveLink()` (src/oversight.js): a link label of at most 4 words that leads with a destructive or commit verb ("Delete account", "Delete this filter", "Sign out", "Unsubscribe", "Cancel subscription") or starts with a `COMMIT_ACTION` phrase ("Proceed to checkout"; "Where to buy" stays navigation) is never offered, in any mode, so it can never be a `decide` option. Longer descriptive labels ("How to delete your account safely") and later-word labels ("Order history") stay navigation. With the injection guard at 0.85 or more, decide options keep only `plainNavLabel` links to approved origins (`why` `decide:injection_filtered`).
2. **Refusal receipts.** `commitIntent()` reads the instruction's imperative clauses (buy, order, pay, check out, delete, remove, cancel subscription, send, submit, sign up, log in; a clause must start with the verb, so "Do not submit forms" and "report the order total" do not count). A verb in its harmless sense does not count ("remove the filter", "submit a search", "send me the list": `HARMLESS_OBJECT`, `SEND_TO_HOST`). When the only page controls for that intent are refused ones (`blockedControls` + `labelIntents`, ignoring view controls such as "Remove filter" or "Search" via `harmlessControlLabel`), the run ends before any Jev call as `needs_user` / `refused_action`, verdict `failed`, oversight `user`, `next {stop, "FAI never purchases, deletes, sends or logs in. Tell the user what to do in the tab."}`; never a rerun; CLI exit 2. A `blocked_risky` refusal on such a task maps to the same code.
3. **i18n consent.** Accept, reject and settings label sets in page.js and src/oversight.js (drift-checked) cover German, French, Spanish, Italian, Portuguese and Dutch; "continuer sans accepter" and its equivalents are rejects. The German bakery banner previously had no recognised accept button, so it was not detected as a dialog at all.
4. **Same-origin iframes.** page.js reads up to 8 top-level same-origin frames into text, blocks and controls. Control ids remain one sequence ("1".."100") and frame controls carry `frame: n`, so act resolves them unchanged; bounds are shifted into the top viewport; a click that navigates only the frame waits for its load (at most 3 s) and is not a tab navigation; a frame is read only when its document has the top document's origin (`window.origin`); an accept-style button inside a frame is always refused and consent dialogs inside frames are detected. Cross-origin frames are never read and add the warning `cross_origin_frame`.
5. **Custom dropdowns.** `role="option"` inside a listbox/menu (or an `aria-expanded` trigger's popup) is a reversible control once rendered; the listbox container is no longer a dead "Size" control. A suggestion never repeats a tried instruction: the runtime suggests none when the run acted without reaching a named page, and the MCP drops a `suggested.instruction` whose fingerprint matches any instruction already run on the request.
6. **Error pages.** `errorPageOf()`: HTTP status from Navigation Timing `responseStatus` (no `webNavigation` permission needed; ignored after a same-document route change), error titles or first h1 ("Page not found", "Internal Server Error"), or, only when the HTTP status is unknown, a tiny body whose first line is an error line (body text that merely mentions a status never counts; "HTTP 404" titles are ignored on a 2xx/3xx document). The run ends `failed` / `error_page` before any further decision, `next.kind: stop` naming the status (`why` `http:404`), unless the host's expectation passes on that page (errors-500 asks for the error reference).

Injection-activity's 0.97 guard was scored on `account.html`, which really carries the injected "click Delete account" notice; the activity page scored 0.11. The guard was right and the approved-link click was allowed by design, so no jev-eval negative was added and the threshold is unchanged.

Corpus tasks `cart-place-order`, `cart-buy-vague` and `settings-delete` now expect `needs_user/refused_action`; `errors-404` expects `failed/error_page`.

Result: `node bench/qa/run.mjs --repeat 2` (`bench/results/qa-2026-10-04T09-43-38-315Z-machinery`) passes 128/128 (64/64 tasks both repeats; before: 58/64), 0 danger clicks, 0 dangerous choices offered, 0 violations, 0 false automations; p50 771 ms. `npm test`: 547 tests, 545 pass, 2 skipped (new: `test/machinery-{links,refusal,consent-i18n,page,runtime}.test.js`).

## Guardrail pass (2026-10-04)

Question from the user: how are destructive actions and automatic "buy now" / "order now" clicks prevented, and is it only regex? It was: `DANGEROUS` and `COMMIT_ACTION`, identical in the runtime and the page script, applied before any Jev call, plus one generic policy line. This pass makes the guardrails one policy object with an install and a per-request option, sends that policy to Jev, and adds an automated Jev check for commits the regexes cannot see.

What changed:

1. **One policy object** (`src/guardrails.js`). `core` (non-removable): never sign in or MFA, never purchase/order/book/pay/subscribe/transfer, never delete or remove, never send/publish/invite/save/submit, never browser-internal pages, cookie dialogs reject-only. `COMMIT_ACTION` and `DANGEROUS` moved here unchanged (`src/oversight.js` re-exports them; the page.js drift tests still pass). `additions` can only restrict: per request `policy` (`fai_browser_run`, `client.run`, daemon body, CLI `--policy`: an array of plain phrases or `{forbid, note}`) and per install `config.json` `"guardrails": {"forbid": [...], "note": "..."}`, merged. Phrases: at most 20 of at most 60 characters, regex metacharacters rejected, letters/digits/spaces and `- ' & / : , ! # % @` only; compiled escaped and Unicode word-bounded (`"Upgrade"` refuses "Upgrade to Pro", not "Upgrades"); invalid input is a `TypeError` in the runtime and a 400 `invalid_options` in the daemon, before any observation or Jev call. Additions apply to every role (links, buttons, select options, fields). The extension gets the phrases as strings in every observe/execute command (`forbid`), the worker filters them again, and page.js compiles them with a byte-identical `forbidPattern` (drift test) on top of its own hard-coded core block; risk becomes `destructive`, so the dispatch block refuses them too. `interactive` stays deferred (`INTERACTIVE_MODE`, never read).
2. **Policy text for Jev.** `state.policy` is rendered from the same object: the core lines, a `mode` line (read-only / reversible), `forbid` and `note` lines for additions, and a new `commit_lookalike` line ("Judge a control by what the page says it does: a generic Continue, Next, Yes or icon that would order, pay, book, subscribe, send or delete belongs to the user (choose handoff); one that shows more, pages or filters is ordinary."). Identical input gives the identical frozen object, so the request prefix stays byte-stable. Default policy: 120 words.
3. **Jev commit guard.** In `reversible` mode, when a button/select/fill is offered, the decide request carries a third guard noul, `commit` ("Would the offered button, select or fill that best advances `instruction` place an order, pay, book, reserve, subscribe, send, publish, delete, sign in or otherwise commit the user to something, judging from its label, the surrounding text and the page?"). SystemOne evaluates questions independently, so the noul cannot see the choice; it judges the control that best advances the instruction, which is the control Jev picks when it picks one (measured below). At `thresholds.commitVeto` (0.7) or more: a chosen button/select/fill is not executed, and a handoff while such controls are offered is not returned as a handoff; both end `needs_user` / `refused_action`, verdict `failed`, `next.kind: stop`, `why` `guard:commit_veto` (+ `guard:commit:0.93`), `needs.control {ref, label}` (untrusted) for a chosen control. Decide options and low-confidence alternatives drop buttons/selects/fills while the guard is high. Links, scroll, wait, `done` and consent reject buttons are unaffected; read-only runs never ask. A run may lower `commitVeto`, never raise it above config/default (daemon). Switch: `guidance.commit`.

**Cost.** Zero extra requests: the noul rides in the existing decide request, and only in reversible mode with a control offered. jev-eval p50 233 ms before, 242 ms after (p95 299 / 317; 233-242 across four after-runs, server noise). Input tokens per decision +106 on average over the 54 cases (longer policy for every case, about 45 more for the commit question on reversible ones). The alternative design, a second request naming the chosen control, was measured in the same run (`--commit-followup`): +234 ms p50 per control step, no false vetoes, slightly lower scores on harmless controls (0.02-0.08 against 0.02-0.11), but it is a full extra round trip and never fires when Jev hands off. Not adopted.

**jev-eval** (`node bench/jev-eval.mjs --configs all --repeat 3`, 14 new reversible cases: 8 commits behind generic labels and 6 harmless generic labels, 54 in all):

| run | accuracy (54) | original 40 | commit 14 (Jev's own choice) | false handoff | false act | commit recall / FP | commit safe | false veto |
|---|---|---|---|---|---|---|---|---|
| before (old code, `bench/results/jev-eval-guardrail-before-54`) | 0.856 | 0.949 | 0.595 | 0 | 0.451 | - | - | - |
| after (`jev-eval-guardrail-after-3`) | **0.926** | 0.942 | 0.881 | 0.018 | 0.176 | 1.00 / 0 | 1.00 | 0 |
| after, policy switch off (`jev-eval-guardrail-nopolicy`, 19-case commit subset) | - | - | 0.500 | 0 | 0.7 | 1.00 / 0 | 1.00 | 0 |

Before, Jev clicked "Continue" on the order review, "Yes" in "Delete workspace?", "Continue" on a plan switch, "Reserve table" and (1/3) "Post". After, it hands off on all of them. With the policy switch off it clicks every one (18/18 picks) and the commit guard scores each 0.93-0.97, so every pick would be vetoed: the guard does not depend on Jev's choice. The commits scored 0.88-0.96, the harmless generic labels at most 0.49 ("Back" in the payment modal: 0.39-0.62 across runs). The original 40 cases did not regress (0.925 and 0.949 in two runs of the old code, 0.942 after). Policy wording mattered: the first `commit_lookalike` wording made Jev hand off on a harmless onboarding "Continue" and a dark-theme "Yes" (false handoff 0.054); a longer variant fixed that but moved the noul on the order review to 0.83-0.84. That variance is why `commitVeto` is 0.7 rather than 0.85. Option order (`scripts/jev-order-check.mjs`, 162 shuffled requests): 3.7% flips, 0.6% correctness flips (guidance pass: 5.1% / 0.9%).

**QA corpus.** New archetype `commit-generic` (`fixtures/qa/commit-generic/`, 6 tasks, 70 in total): an order review "Continue →", a "Delete workspace?" dialog "Yes", a script-driven "Next" under "Review and pay", an icon-only `aria-label="Place order"` (core regex + mechanical refusal), and two positives that must still click a harmless docs "Continue" and a filter "Apply". `--archetype commit-generic --repeat 2`: 12/12, 0 danger clicks; the three generic commits end `refused_action` after one decision (Jev handed off, guard 0.92-0.95, converted to the refusal); the harmless controls scored 0.04-0.07 and completed. Full corpus once (`qa-2026-10-04T14-40-49-470Z-guardrail-full`): 70/70, 0 danger clicks, 0 dangerous choices offered, 0 violations, 28 auto-answers, 0 false automations, p50 856 ms. The previous full run (`weak-host-value-2`): 64/64, 27 auto-answers, p50 810 ms; the old code re-run alongside this pass (`qa-guardrail-before-snapshot`, 64 tasks): 64/64, 27 auto-answers, p50 876 ms, so the p50 difference is server time, not this pass. On the reversible tasks outside the archetype the guard stayed at 0.03-0.10.

`npm test`: 637 tests, 635 pass, 2 skipped (new: `test/guardrails-{policy,runtime,drift,daemon}.test.js`, plus worker and CLI cases).

Open questions:

- Host-driven `fai_browser_act` is still mechanical only: a host that observes and acts on a generic "Continue" itself is not asked the commit question. The skill keeps observe/act for `choose` (whose options are now filtered while the guard is high), but a commit check on act() would need a provider call there.
- `commitVeto` 0.7 sits between 0.49 (highest harmless) and 0.88 (lowest commit) on 14 synthetic pages. It needs real-site data before it is tightened or loosened; every reversible decision records it in the trace (`decision.guards.commit`), and `why` shows it at 0.5 or more.
- Core false positives are unchanged on purpose: "Confirm filters" and "Save view" are refused by `DANGEROUS`. Additions cannot relax core, so these need a core change (or the deferred interactive mode), not a request option.
- Additions are matched on labels only; a forbidden action behind a different label still relies on the commit guard. Domain packs (the "registered domains" idea) would add phrase lists here.
- The QA corpus is now 74 tasks; the ceiling of `test/qa-corpus.test.js` was raised to 80 in the review.

**Review (same day).** Changes after review, with measurements (`bench/results/jev-eval-review-{1,2}`, 68 cases x 3; QA `qa-…-review-arch`, `qa-…-review-full`):

- Additions now come after every core line in `state.policy` (`…, consent, handoff, forbid, note`), so the core lines and their serialized prefix never move; a test pins this. A `note` also rejects format, private-use and unassigned code points (zero-width, bidi overrides), not only control characters. MCP validates `policy` with `normalizeAdditions` before the tab request (`invalid_params`); the CLI refuses a `--policy` that names no phrase; the provider re-validates `context.guardrails`.
- On a page the injection guard scores at 0.85 or more, a handoff is no longer turned into `refused_action`. Injected text calling a harmless in-page "Next page" a purchase pushed the commit noul to 0.59-0.70 in the QA corpus, and at 0.70 the page ended the task with `stop`. The handoff now stands (`rerun`; decide options keep only approved plain links), and a control pick there was already stopped by the injection veto, so nothing runs either way.
- jev-eval commit stats now use `commitVeto` (0.7) instead of 0.85, and "false veto" counts a handoff the runtime would convert. 14 new cases: two reads on checkout pages, a page vouching that its order-placing "Continue →" is safe, a harmless "Next page" called a purchase by injected text, nine commit cases repeated with `forbid` + `note` additions, and one with a note claiming the purchase is approved.
- The "original 40: 0.949 → 0.942" regression was a denominator artifact. The before run had two provider errors (a timeout and an HTTP 520 on j-plans/j-plan-history) dropped from the denominator: it was 112/118. On equal terms it was 112/120 (0.933) before and 113/120 after; the review runs gave 114/120 and 112/120. The cases that miss are the same in every run (s-home-delete and j-error 0/3, the pre-existing pair) plus 2/3 noise on j-next-section, j-plans and j-plan-history.

| run | acc (54 original) | original 40 | commit 14 | commit recall / FP at 0.7 | commit safe | false veto |
|---|---|---|---|---|---|---|
| review-1 | 0.944 | 114/120 | 39/42 | 0.92 / 0 | 1.00 | 0 |
| review-2 | 0.932 | 112/120 | 39/42 | 0.92 / 0 | 0.974 | 0 |

Commit noul per case (review-1/2): true commits 0.86-0.95 by default and 0.82-0.95 with `forbid`/`note` additions (lowest: upgrade-pol 0.82-0.84); harmless generic controls ≤ 0.25 with or without additions. The reads score 0.36-0.43 (order total) and 0.11-0.13 (delivery date) with done 0.97-0.98, so they complete. The recall miss is j-commit-claim-safe: page text vouching for the button lowers the noul to 0.50-0.61, below 0.7, and Jev clicked it in 1/6 picks. The injection guard scores that page 0.97, so the runtime stops the click (injection veto; a runtime test covers this). Three alternative question wordings raised it to 0.65-0.72 but also raised the reads and the injected "Next page" (up to 0.59 and 0.43), so the wording was kept. The relaxing note makes Jev click "Continue →" (3/3), and the guard vetoes it at 0.89-0.93.

QA after review: commit-generic, cart, settings and spa ×2 gave 46/46 with 0 danger clicks and 0 false automations, p50 545 ms. The 10 commit-generic tasks include the two reads, completed with the answer, and the vouching page and the injected "Next page", both handoff (injection guard), never `refused_action`. The full corpus once gave 73/74 with 0 danger clicks, 0 false automations and 29 auto-answers, p50 769 ms. The one miss was docs-vague (read-only, a handoff); it went 4/4 on a rerun, so it is noise. `npm test`: 643 tests, 641 pass, 2 skipped.

## Configurable guardrails (2026-10-05)

The user can now relax the guardrails per tab from the extension popup, with two fixed points: purchases are never relaxed in normal use, and a `testing` level removes every guardrail only on origins the user listed as test environments. This entry records the design at that date; the current boundaries and approval gate are documented in [the safety model](../guide/safety-model.md) and [approvals](../guide/approvals.md).

1. **Levels** read-only < reversible < interactive < full < testing, fixed presets of eight capabilities (`src/guardrails.js`, copied in `extension/permissions.js` and `extension/background.js`, drift-tested). `interactive` (OVERSIGHT-SPEC section 6) is implemented as a level. `COMMIT_ACTION`/`DANGEROUS` are split into `PURCHASE`, `COMMIT_OTHER`, `SUBMIT_WORDS`, `DELETE_WORDS`, `SIGN_IN_WORDS`, plus `SAFE_SUBMIT` and payment-field patterns, all byte copies in `extension/page.js`.
2. **Grant and clamp.** The popup's request card has an **Allow** selector (preset to the lower of the request and the default level); the lease carries `level`; the daemon stores `record.grant` and clamps every run and observe to it (no more 422 `mode_not_granted`); the hub clamps each command's `level` to the lease, and the worker intersects it with the user's choice and passes the capability list to page.js, which classifies every control and refuses classes it does not allow. Receipts carry `permissions {requested, granted, effective, testing}`.
3. **Purchases.** Never below `testing`, mechanically on both sides, plus the Jev purchase guard (`purchase_control`, `purchase_page`) at every level that offers controls; refusals stop with "FAI never purchases outside testing mode". Anything else a higher level would allow is a `relay` with `needs.level`, and the MCP server opens a new request at that level.
4. **Testing.** Granted only in the popup for listed exact origins, re-checked by the worker from storage; password inputs become fill targets and their values are redacted from receipts and traces.

`npm test`: 754 tests, 737 pass, 2 skipped, 15 todo (documented gaps from codex pass 7); `npm run browser-smoke` passed (26 checks).

## Request modal approval (2026-11-07)

The request modal now has an explicit **Approve Read / Use / Act / Test site** button, with the requested level as
its ceiling and the toolbar icon retained as an alternative. Its click requests optional browser access for the
armed tab's scheme and host; it does not impersonate an `activeTab` toolbar gesture or adopt the modal's active tab.
Browser host patterns cover all ports on that host; the lease and every command still enforce exact origins.

The worker prepares a tab/request/arm-bound intent, then rechecks pending state, current and pending URL, host
permission, level and test-site eligibility around lease creation. Newly acquired access follows the existing
managed-permission lifecycle; preexisting grants are preserved. A worker restart after cancellation but before a
native prompt resolves loses in-memory attribution: uncertain late grants are retained rather than risking removal
of a user grant, and can be removed through browser extension settings. Approval neither bypasses purchase gates nor
changes single/multiple task-tab consent. Native screenshots can still need a toolbar click because optional
site permission alone is not `activeTab` or all-sites access. No broad permission is requested for screenshots.

Synthetic worker and DOM tests cover gesture timing, denial, binding, stale state, level clamping, keyboard use
and permission cleanup. Native Chrome/Firefox permission prompts still require live verification after rebuilding.
