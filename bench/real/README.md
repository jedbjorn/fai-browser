# Real-website probe

What breaks when FAI Browser navigates live sites? `probe.mjs` drives FAI with the TypeSafe Jev provider directly
(no coding agent, no Codex quota) on the tasks in `tasks.json` and records everything per run.

```sh
node bench/real/probe.mjs --list
node bench/real/probe.mjs                                   # every task, base instruction, task mode
node bench/real/probe.mjs --tasks hn-comments,mdn-array-at --mode reversible
node bench/real/probe.mjs --tasks pydocs-read-text --variant 1   # retry with tasks.json variants[0]
node bench/real/probe.mjs --regrade bench/real/results/<dir>     # recompute grades and summary.json from disk
```

Options: `--tasks id,id`, `--landing-only` (request only the landing origin, the earlier behaviour; by default the request lists the landing origin, the start URL's origin and the task's optional `origins`, so a consent.google.com landing can redirect back to www.google.com), `--mode read-only|reversible` (overrides the task's mode), `--variant N` (0 = base
instruction, N = `variants[N-1]`), `--out DIR` (default `bench/real/results/<timestamp>[-label]/`), `--label`,
`--profile on|off` (the curated site profiles from `domains/`, copied to a scratch `FAI_DOMAINS_DIR`, with the run
body's `profiles` switch; `mdn-array-at`, `github-license` and `gflights-week-window` have profiles; the record gets
`site`, `decisions`, `fastSteps` and `profile-stats.json`). Without the flag no profile applies (site profiles are opt-in).

A task may carry `steps` (sent as one step list instead of `instruction`, which is then only its summary; the record
gets `stepResults` and the summary `stepsPassed`), `timeoutMs` (replaces the 90 s run timeout) and `preConsent` (a
button label such as "Reject all": a consent wall on its own `consent.*` host is answered with Playwright before the
tab request, because headless Chromium does not grant the extension the second origin and the session could not
follow the wall's redirect). `gflights-week-window` is the 7-day Google Flights window from the 7 Oct one-way results
page, one step per day.
Requires `npm run setup` once (the daemon reads the Jev key from `.env.local` itself; the probe never reads it),
`/usr/bin/chromium` (or `CHROMIUM_PATH`) and network access.

## What one run does

1. Launches headless Chromium with a copy of `extension/` whose manifest grants `<all_urls>` (the same test
   manifest as `scripts/browser-smoke.mjs` and `bench/fai-condition.mjs`), a fresh profile, a real Chrome user
   agent (`--user-agent` and the context UA, `navigator.webdriver` off) and a 1280x900 viewport.
2. Opens the start URL and takes an independent Playwright census of the landing page: final URL (redirects),
   controls in the viewport and in total, open shadow roots and the controls inside them, iframes, and consent or
   bot-wall wording. Saves `landing.png`.
3. Starts an isolated daemon through the SDK (`FaiBrowserClient.connect`) with a scratch `FAI_DAEMON_DIR`, a random
   `FAI_BRIDGE_PORT` and a disposable `FAI_BRIDGE_SECRET`. `FAI_HOME` stays the package root, so the user's
   daemon on 4318 is untouched and the key never passes through the probe.
4. Pairs the popup, requests the tab for the landing origin plus the start URL's origin (and `origins`), and
   approves it on the popup's request card at the run's mode (`FaiRun.approve` from `bench/fai-condition.mjs`). `allowedUrls`
   outside those origins are dropped and counted (`allowedUrlsDropped`).
5. Patches `WebSocket.prototype.send` inside the extension service worker (in memory only) to record the
   `{code, message}` of every error the extension sends; the trace keeps only the code.
6. One `observe` (no provider call) for Chrome round-trip time, control count and digest size.
7. One `client.run` with the task's instruction, expectation, mode, `answerQuestion`, `allowedUrls`, `maxActions`,
   `capture: "each"` and `timeoutMs: 90000` (plus a 15 s client-side abort margin).
8. Reads the trace and records per-step action, label, target URL, confidence, `done` probability, settle reason
   and timings; the final decision; final-page control and block counts; and the grade.
9. Releases the request, closes Chromium, SIGTERMs the daemon (by its `FAI_DAEMON_DIR`), keeps the daemon log.

## Output

`results/<dir>/<task>.<mode>.v<variant>/`: `run.json` (everything above plus the lean result), `log.txt`,
`daemon.log`, `landing.png`, `final.png`, and `artifacts/` (the observe and run traces with step screenshots).
`results/<dir>/summary.json` holds one row per run.

The grade tests the task's `answerPattern` (a regex the true answer matches) against `page.digest` (`inDigest`),
`answer.candidates` (`inTopCandidate`, `inCandidates`), `trail`, the final observation's blocks and visible text,
and the final controls' labels and select options (`inControlOptions`). That separates "the page had the answer
but the digest dropped it" from "the scanner never saw it".

`suggestedClass` is a heuristic first guess; the failure class in a report should be set by reading the run.
Classes: consent_banner, bot_block, shadow_dom, iframe, controls_cap, blocks_cap, submit_blocked, typeahead_needed,
infinite_scroll, slow_settle, cross_origin_redirect, jev_wrong_turn, done_gating, other.

## Caveats

- Live sites change; HN and the travel sites change by the minute. Results are a snapshot.
- Headless Chromium with a real UA still differs from a user's Chrome (no cookies, no history, datacenter or home
  IP geolocation decides consent walls). Bot walls seen here may not appear for a real user, and vice versa.
- Each run calls Jev up to `maxActions` + 1 times plus one answer-ranking call.
- Page text ends up in traces and `run.json` under `results/`; treat them as local records.
