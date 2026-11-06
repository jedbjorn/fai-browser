# Live bench

How does FAI Browser do as close to real use as we can get? `bench/live/run.mjs --live` runs a real Claude Code host (`claude -p`, Sonnet 5.5 at low effort by default) with the real installed MCP entry against the owner's long-running daemon on `127.0.0.1:4318`. That daemon is connected to the owner's headed Chrome (profile "Public"), and the owner approves each tab request in the extension popup. The tasks run on live public websites and on the owner's own signed-in web app, not fixtures. Prompts are written the way a user would type them to Claude Code, so the host picks every `fai_browser_run` parameter itself.

`--private` runs the same pipeline against a private daemon, headless Chromium and the fixture site, with auto-approval. It works like `bench/compare.mjs` condition R and is how the runner itself is verified.

## What it measures

Each run records the same metric fields as `compare.mjs` (see `bench/README.md`, "What is measured"), plus the FAI side:

| Field | Source |
|---|---|
| Pass and grading | `auto` when the task's `answerPattern` (regex, tested on the host's reply) or `expected` list matches; `manual` when the task has neither, in which case the owner grades it in `grades.json` |
| Wall s | the whole `claude -p` session, approval time included |
| Approval s | live: an estimate (see Caveats); private: the harness's popup clicks |
| Requests, Turns | Requests: distinct model requests (assistant message ids) of the session, ToolSearch and skill loads included (`hostToolUses` counts them), as compare.mjs counts them. Turns: Claude Code's own `num_turns`, which can be one higher |
| Tool calls, run calls, FAI runs, steps sent | MCP tool calls; `fai_browser_run` calls; distinct daemon runs (run ids in the receipts, `fai_browser_act` included); steps sent in step lists |
| Outcome `approval_timeout` | every `fai_browser_run` call ended `needs_user`/`select_tab` (the owner had not approved within the per-call wait) and no FAI run happened. Such runs are counted (`Approval timeouts`) but kept out of Passed/graded. `approvalTimeouts` and `invalidParams` count those calls in any run |
| Jev req, Jev s, Hops | from each run's `trace.json`: `cost.requests` entries and their `ms`, and `steps` |
| Auto answers, oversight, false automation | receipts with `verdict.answer`; the final receipt's `verdict.oversight`; auto-confirmed answers the grader rejects (only for auto-graded tasks) |
| Cost $ | the host's tokens at `bench/prices.json` list prices (Claude's reported `total_cost_usd` is in `run.json`) |
| Signals | for tasks with `expectSignals` (such as `gf-date-grid` and `unreadable_region:canvas`), whether the code appeared in any receipt or trace |

Per run, `runs/<task>.<host>.<rep>/` holds:

- `prompt.txt`
- `command.json` (argv, the MCP entry and env names; never a secret: the private pairing secret is replaced by a placeholder, and live mode has none)
- `events.jsonl` (the stream-json), `stderr.txt` and `final.txt` (the host's reply)
- `receipts.json`: every `fai_browser_*` result, with status, code, verdict, next, needs, permissions, trail length, cost, trace path and answer
- `run.json`
- `traces/<runId>.json`: a copy of each run's daemon trace, read from the trace path the receipt names, else from `FAI_HOME/artifacts/<runId>/trace.json`

The results directory also holds `runs.jsonl`, `config.json`, `checklist.json` (private mode only), `grades.json`, `answers.md`, `summary.json` and `summary.md`. Traces, receipts, `final.txt`, `answers.md` and `grades.json` can contain page text. `summary.json` and `summary.md` never do: they hold only numbers, fixed codes and grades, with home paths written as `~`. Only the summaries are published (`.gitignore`).

## Live runbook (operator, with the owner present)

1. On the new main, in the checkout the daemon serves (`<checkout>`): `node src/cli.js daemon restart`.
2. In Chrome, profile **Public**: open `chrome://extensions` and reload the unpacked FAI Browser extension. Click its icon once and check that it shows as connected.
3. Run the bench from that same checkout:
   ```sh
   node bench/live/run.mjs --live                          # every task that is not skip: true
   node bench/live/run.mjs --live --tasks wiki-tagus       # one task
   node bench/live/run.mjs --live --tasks gf-week-window,gf-cheapest-day,gf-date-grid --host sonnet:low --host opus:low
   node bench/live/run.mjs --list                          # ids, modes, prompts with today's dates filled in
   node bench/live/run.mjs --live --dry-run                # prompts and exact host commands; contacts nothing
   ```
   Before the first task the runner prints a checklist and waits for Enter. It checks:
   - Claude Code is installed.
   - A daemon answers on 4318 and runs this checkout's version.
   - The daemon's home is this checkout.
   - The daemon started after the last commit on main (a loud `!!!` warning if not).
   - This checkout is at main.
   - The extension is connected and the daemon has a Jev key.
   - No requests or runs are open.
   - Which `FAI_*` variables it strips from the host's environment.

   Any `[FAIL]` line stops the run.
4. For each task the runner prints the task id, its mode, its origins, the start page and the prompt, then waits for Enter. The owner opens the start page in Chrome first. When the host calls `fai_browser_run`, the runner prints `>>> waiting for the owner to approve the tab for <origins>`. The owner clicks the FAI Browser icon, picks the printed level in **Allow** and clicks **Approve this tab**. While the run goes on, the runner prints one line per receipt (status/code, `next.kind`, and `needs.level` when the task needs a higher level). On a `needs` receipt the host may ask again at that level, and the owner approves again. After each task the runner prints the result line and waits for Enter (`q` stops; Ctrl+C finishes the current task and writes the summary). `--yes` skips every pause, for an owner who keeps the popup at hand.

   What the owner sees: the extension badge `?` and a request card naming the origins, the level and the host's reason. Google tasks request `www.google.com` and `consent.google.com`. A consent wall is rejected automatically. A sign-in page or an accept-only cookie dialog comes back as `relay`, and the owner clears it.
5. Results go to `bench/live/results/live-<timestamp>/` (or `--out`). The summary is printed at the end.
6. Grading: auto rows are graded already. For manual rows (`gf-week-window`, `gf-date-grid`, `booking-search`, `expedia-search`, `dosarch-recon`), read `answers.md`, set `"pass": true` or `false` in `grades.json`, then run `node bench/live/run.mjs --regrade bench/live/results/live-<timestamp>`. Regrading recomputes auto grades from the current task file, applies the owner's grades and rewrites the summaries.

How the live entry finds the daemon: in a scratch workspace, the runner runs the real installer (`installIntoWorkspace`, project scope). The installer writes `.claude/skills/fai-browser/` and `.mcp.json` with the plain Claude entry, `{"type":"stdio","command":"<node>","args":["<checkout>/src/mcp-main.js"]}`, which has no `env`. The runner adds only `FAI_MCP_MAX_CALL_MS` to it (see below), and that `.mcp.json` is the `--mcp-config`, under `--strict-mcp-config`. The host process gets no `FAI_*` variables. The server therefore resolves `FAI_HOME` to the package root of `src/mcp-main.js` (this checkout). It reads the port from `daemon.json` in that home, else uses 4318, and reads the client token from `<home>/client-token` itself (`src/paths.js`, `src/home.js`, `src/client.js` `resolveClientPort`/`ensureDaemon`). That is why the bench must run from the checkout the daemon serves. A worktree has no `client-token`, and its entry would point at the worktree's code. The runner never reads `.env.local` or `client-token`. The checklist gets daemon status through `src/client.js` (`FaiBrowserClient.connect({autoStart: false}).status()`, the path `node src/cli.js daemon status` uses). It first checks `GET /v1/health`, because connecting to an idle daemon of another version would make the client restart it.

Host flags are condition R's (`bench/README.md`, "Condition R"):
- `--setting-sources project`, with only the installer's files in the workspace
- default tools, with `Bash`, `WebSearch` and `WebFetch` disallowed
- `--allowedTools 'mcp__fai-browser__*,ToolSearch,Skill'`
- `--permission-mode dontAsk`, `--no-session-persistence`, and the context probe before the first task

Live-only settings:
- `FAI_MCP_MAX_CALL_MS` in the server entry's `env` (`--approval-wait-ms`, default 180000): how long one `fai_browser_run` call waits for the owner's approval
- `MCP_TOOL_TIMEOUT`, the larger of 600000 and the approval wait + 120000, so Claude Code never cuts a call the server is still waiting in
- a 15-minute `timeout(1)` per task (`--timeout-s`)
- `--max-budget-usd 3`
- Claude Code's own prompt-cache TTL (`--claude-cache-ttl default`; private mode uses `5m` like compare.mjs)

The approval wait is the one change to the plain entry. The server's own default per-call deadline is 45 s (`maxCallMs` in `src/mcp.js`), and hand-run live sessions lost runs to it: the call ended `needs_user`/`select_tab` before the owner had approved. Setting `FAI_MCP_MAX_CALL_MS` in the shell did not help, because the call still ended at about 45 s; the stdio server does not get that variable from the host's environment. So live mode writes it where the installer puts env, the entry's own `env` object (`hostEntry('claude', {command, args, env})` writes `{"type":"stdio","command":...,"args":[...],"env":{...}}`). The resulting entry is `{"type":"stdio","command":"<node>","args":["<checkout>/src/mcp-main.js"],"env":{"FAI_MCP_MAX_CALL_MS":"180000"}}`, and `command.json` records it. Any other env key in the installed entry stops the run.

## Tasks (`tasks.json`)

Each task has:
- `id` and `prompt` (natural language)
- `origins`: only what the task needs
- `mode`: the lowest level that does the task
- `startUrl`: what the owner opens first
- optional `answerPattern`, `expectSignals` and `notes`

`{{DATE+N}}` is today + N days (local, `YYYY-MM-DD`); `{{DATE+N|long}}` gives "Wednesday 7 October 2026" and `{{DATE+N|dm}}` gives "7 October". The placeholders are filled at load time in every field. Tasks with `skip: true` are listed and never run (`dosarch-t2`, `dosarch-t3`: placeholders still to be written).

- `gf-week-window`, `gf-cheapest-day`, `gf-date-grid`: Google Flights, MRS to London over the next week. They use read-only, reversible and reversible respectively. The date grid task records whether `unreadable_region:canvas` appears.
- `wiki-tagus`, `hn-comments`, `mdn-array-at`, `github-license`, `pydocs-read-text`: the `bench/real/tasks.json` probes as user prompts, with the same `answerPattern` and mode.
- `booking-search`, `expedia-search`: interactive searches for Paris, 2 nights, two weeks out, with no booking. The answer is the cheapest price on the first results page, graded manually.
- `dosarch-recon`: the owner's own app, read-only, graded manually.
- `dosarch-t1-sections`: open Projects, then Orgs, then Flags through the top navigation buttons and report the count and names in each; reversible, graded manually.

## Importing hand runs

```sh
node bench/live/run.mjs --import <runs-dir> --out bench/live/results/live-2026-10-06-hand
```

This converts run dirs made by hand. Each dir is `<runs-dir>/<id>/` with `prompt.txt`, `events.jsonl` (claude stream-json), `stderr.txt`, `started.txt`, `ended.txt`, `exit.txt` and `traces/<runId>.json`; any other file is ignored. The conversion produces the same `run.json`, receipts, trace copies and summaries as `--live`. The host is the first `--host` (default `sonnet:low`). Every imported run is graded manually, and `--regrade` keeps it so. An id ending in `-rN` is repeat N of the id without the suffix. Wall time is the result event's `duration_ms`, else `ended - started`. Call times come from the events' timestamps against `started.txt`, which has 1 s resolution, so the approval estimate is accurate only to about a second.

## Private mode (verification)

```sh
node bench/live/run.mjs --private --tasks about-members,pricing-pro --host claude:claude-sonnet-5-5:low \
  --out bench/live/results/private-smoke
```

Private mode serves `fixtures/site` (or the task file's `site`, or `--site-dir`) and takes tasks from `bench/tasks.json`, or from `--tasks-file bench/qa/tasks.json`. It starts a private daemon (random port, scratch `FAI_DAEMON_DIR`, disposable pairing secret) and headless Chromium with the test-manifest extension. The harness approves at the task's `mode`. The prompt is condition R's (`prompts/common.md` + `prompts/fai-real.md`). Private mode also runs the live checklist code once against the private daemon (`checklist.json`). When run from a worktree, pass `--fai-home /path/to/main/checkout` so the private daemon finds the Jev key there. Traces then land in that checkout's `artifacts/`, and the runner copies them. `npm test` (`test/live-bench.test.js`) covers the pure parts and checks the committed `results/private-smoke/summary.json`.

Smoke result (2026-10-06, Sonnet 5.5 low, `bench/live/results/private-smoke/`): `about-members` and `pricing-pro` both passed. Each took 2 host turns, 1 `fai_browser_run` call, 4 Jev requests and 1 hop. Wall time was 8.9 s and 5.9 s, the harness approval about 0.4 s each, and the total cost $0.049.

### Fixture tasks: a real host on the live-like Google Flights fixture

```sh
node bench/live/run.mjs --private --tasks-file bench/live/tasks-fixture.json --host claude:claude-sonnet-5-5:low \
  --fai-home <checkout> --repeat 2 --out bench/live/results/fixture-<name>
```

`tasks-fixture.json` serves `fixtures` (its `site`) and runs on `fixtures/long/flights-live`. Its tasks have a `prompt`, written the way a user types to Claude Code, and private mode sends it as is (no `common.md`, no ANSWER line, nothing about FAI parameters). Grading is the task's `answerPattern` on the host's reply, with the gold facts of the `bench/long` flights-live tasks (easyJet, 10:40 AM, €58, Thu 15 Oct):
- `fx-form-day` starts on the search form: destination with autocomplete, the Departure calendar and Done, Search, View more flights, then a read of one day.
- `fx-results-week` starts on the Mon 12 Oct results page: change the day six times and read each day, View more flights included.

`--fai-home` points the private daemon at the checkout that holds the Jev key; the runner never reads it. Each run costs real host money (about $0.05 to $0.50).

Besides the columns above, the summary counts per run the `fai_browser_run` calls that carried `steps` (Step calls), the ones that sent `suppliedText`, and the calls that ended `needs_host` or `unverified`. Its "What the host sent" section gives one shape per call: `steps N [each step's expectation keys]` or `plain`, the instruction length, the `suppliedText` field names (never values), the expectation keys and the status the call ended with.

## Caveats

- **Billing.** The host runs on the owner's Claude subscription: one session per task and host, plus the context probe. The Jev key pays for each `fai_browser_run`.
- **Live sites drift.** Layouts, consent walls, bot walls (Expedia, Booking) and prices change by the hour. A `blocked`, `consent_banner` or `login` receipt is a recorded outcome, not a harness failure. Compare runs from the same session, and rerun before quoting a number.
- **Approval time is in Wall s.** In live mode, `Approval s` is an estimate made from receipts and traces. For each `fai_browser_run` call whose receipt names a run, it is the time from the call's start (stream clock) to that trace's `startedAt`. A call that returned `relay` with no run while the request was pending counts in full. The estimate includes small MCP and daemon overhead, about 0.1 s per call in private runs: the estimate there was 0.55 s against a 0.42 s harness click. The MCP server tracks the exact wait (`approvalMs` in `src/mcp.js`), but the receipt does not expose it, so the two are not separated exactly.
- **Human in the loop.** The time the owner takes, and whether they approve at the printed level, changes host behaviour. A call that outlasts the approval wait (`--approval-wait-ms`) returns `needs_user`/`select_tab`, and the host may call again or give up; a run with no FAI run at all is recorded as `approval_timeout`. Note anything unusual in `grades.json` `note`.
- **Digest is text, not controls.** The receipt's `page.digest` carries page text, not the page's controls. A "describe the controls" prompt (`dosarch-recon`) needs `fai_browser_observe` to list buttons, fields and links; from the digest alone the host can describe only the text.
- **Sonnet sends `instruction` with `steps`.** On its first call for a multi-hop task Sonnet 5.5 sends `instruction` together with `steps`. Today's server refuses that as `invalid_params`, which costs a host turn (`invalidParams` in the summary; seen in `gf-week-window` and both `dosarch-t1-sections` hand runs). Another change is making the server accept the combination.
- **Only Claude hosts.** Condition R's reasons apply (`bench/README.md`).
- **Retention.** The daemon keeps the last 50 runs in `FAI_HOME/artifacts`. The runner copies each task's traces as soon as the task ends.
