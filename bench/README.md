# Agent comparison benchmark

> Note: the experimental Jev autopilot was removed after 0.6.2, and with it `fai_browser_run`, the Jev tools `bench/jev-eval.mjs`, `bench/jev-replay.mjs`, `bench/request-size.mjs` and `bench/state-audit.mjs`, the long-horizon corpus (`bench/long/`), the QA direct runner (`bench/qa/run.mjs`, `bench/qa/session.mjs`) and the real-site probe (`bench/real/probe.mjs`). Condition B and R below describe the Jev-era protocol (one `fai_browser_run` per task); their prompts and results are historical until the harness is ported to the agent-driven loop.

For Agent direct (your agent driving, the only mode) and multi-step forms, uploads, approval, secret handling and paging, use the [showcase suite](showcase/README.md). It also documents the native-host relay used when a nested CLI cannot write its installation state. The older comparison below includes experimental Jev-driver protocols; do not combine those results with Agent direct measurements.

Is a coding agent faster at browser tasks with FAI Browser than without it, and by how much, and on which host model? This harness runs a host agent on the same read-only tasks under two conditions. The host is OpenAI Codex CLI (`codex exec --json`, default `gpt-6.1-sol` at medium effort) or Claude Code (`claude -p --output-format stream-json`), chosen per run with `--host`:

- **A, baseline.** The host with Playwright MCP (`@playwright/mcp`, headless, isolated profile) as its only browser tool.
- **B, FAI.** The host with the FAI Browser MCP server (`fai-browser-mcp`). Chromium runs headless with the extension loaded. The harness plays the user: it opens the start page and approves each tab request in the extension popup, on the request card at the task's `mode` (picked in the card's Allow select; tasks without a `mode` get the card's preset, read-only).
- **R, FAI as a real install (Claude hosts only).** Like B, but the host runs the way a user's `fai-browser install --host claude` leaves it, so the turns B hides are counted. See "Condition R: real install" below.

## Running

```sh
node bench/selftest.mjs --browser                 # offline checks, no quota: metrics, site answers, popup approval
node bench/compare.mjs --list                     # task ids
node bench/compare.mjs --dry-run --tasks pricing-pro   # print prompts and exact codex commands
npm run bench:compare -- --condition a --tasks pricing-pro,docs-auth-header
npm run bench:compare -- --condition both --repeat 3
npm run bench:compare -- --condition b --baseline bench/results/<earlier-run>   # B-only rerun against A and old B
npm run bench:compare -- --condition b --host codex:gpt-6.1-sol:medium --host claude:claude-sonnet-5-5:low   # host matrix
npm run bench:compare -- --condition b --tasks-file bench/qa/tasks.json --tasks login-wall,consent-accept-only   # QA corpus
```

| Option | Default | Meaning |
|---|---|---|
| `--condition C` | `both` | Which conditions to run: `a`, `b`, `r`, `both` (A and B), `all` (A, B and R) or a comma list such as `b,r`. See "Run order and prompt caching" for the order. |
| `--real-tools run\|eager\|deferred` | `run` | Condition R's server entry: `run` is what `install --host claude` writes (no key; only `fai_browser_run` eager, through the server's `_meta`), `eager` is `install --always-load` (`"alwaysLoad": true`), `deferred` is `"alwaysLoad": false` (every FAI tool behind ToolSearch, like an install before the `_meta`) |
| `--tasks id,id` | all | Subset of the task file |
| `--tasks-file FILE` | `bench/tasks.json` | Task file in the `bench/tasks.json` schema, for example the QA corpus `bench/qa/tasks.json` (see below) |
| `--site-dir DIR` | the task file's `site`, else `fixtures/site` | Site served for each run (see below) |
| `--repeat N` | 1 | Runs per task, host and condition. Table cells are medians. |
| `--host V:SLUG[:EFFORT]` | `codex:gpt-6.1-sol:medium` | Host model; repeatable or comma-separated. `V` is `codex` or `claude`; effort defaults to `medium`. Aliases: `astra`, `sol`, `luna`, `terra` (Codex), `opus`, `sonnet` (Claude), e.g. `--host sonnet:low`. |
| `--model`, `--effort` | `gpt-6.1-sol`, `medium` | Shorthand for one Codex host (`codex exec -m`, `-c model_reasoning_effort=`). Next to `--host` they add one more Codex host. |
| `--timeout-s N` | 300 | Per-run limit, enforced with `timeout -k 10 Ns <host> ...` |
| `--out DIR` | `bench/results/<timestamp>/` | Results directory |
| `--baseline DIR` | none | Merge an earlier results directory (`runs.jsonl`, else `summary.json`) into the summary: its A rows as A (A-baseline when A also runs now on the same host) and its B rows as B-baseline. Rows without a `host` field get the host from that run's `config.json` (`model`, `effort`), else `codex:gpt-6.1-sol:medium`. Request counts missing from older records are recomputed from their `events.jsonl`. |
| `--prices FILE` | `bench/prices.json` | Price table for the Cost $ column |
| `--price-cached W`, `--price-cache-write W`, `--price-output W` | `0.1`, `1.25`, `5` | Weights for the `priced` column, relative to one uncached input token |
| `--claude BIN` | `$CLAUDE_BIN` or `claude` | Claude Code binary |
| `--claude-max-turns N`, `--claude-budget-usd X` | `40`, `2` | `claude -p --max-turns` / `--max-budget-usd` backstops per run |
| `--skip-claude-probe` | off | Skip the context probe before Claude runs (see below) |
| `--chromium PATH` | `$CHROMIUM_PATH` or `/usr/bin/chromium` | Browser binary for both conditions |
| `--playwright-mcp SPEC` | `@playwright/mcp@latest` | npm spec for A, installed once through npx and resolved to its binary |
| `--playwright-npx` | off | Start A through `npx -y` on every run instead (adds npm resolution to wall time) |
| `--fai-mcp-command CMD` | resolved `fai-browser-mcp` | Command for B's MCP server |
| `--keep-codex-tools` | off | Keep Codex built-ins (see below) |
| `--order contiguous\|interleave` | `contiguous` | `contiguous`: one timeline per host x condition (warm-up, then every task x repeat back to back), condition order alternated per host. `interleave`: the earlier per-task alternation. |
| `--interleave` | off | Same as `--order interleave` |
| `--warmup N` | 1 (contiguous), 0 (interleave) | Warm-up runs per timeline, excluded from every table and total |
| `--warmup-task ID` | `about-members` if present, else the first task | Task the warm-up runs |
| `--no-abba` | off | Keep the same condition order on every host |
| `--no-stable-paths` | off | A new random scratch path and site port per run instead of one per timeline |
| `--claude-cache-ttl 5m\|1h\|default` | `5m` | Sets `CLAUDE_CODE_PROMPT_CACHE_TTL` for Claude runs; `default` leaves Claude Code's own (1 h on a subscription) |
| `--sandbox-network` | off | `-c sandbox_workspace_write.network_access=true`. Not needed: MCP servers run outside the sandbox. |

Each run gets a fresh fixture site server, an empty scratch workspace outside the repo (`codex exec -C`, or the `claude` process's cwd), and for B a fresh Chromium profile, pairing secret and FAI port. With stable paths (the default) the workspace path and the site port stay the same for every run of a host x condition timeline; the contents are new each run (see below).

## Run order and prompt caching

Both hosts cache the prompt prefix (system prompt, tool stubs, cwd, task prompt) between requests and, when the bytes match, between runs. How runs are ordered therefore changes uncached input and cost, so the harness fixes the order and records the cache state of every run.

- **Timeline (default).** For each host, for each condition: one warm-up run, then every task x repeat back to back. The condition order alternates per host (host 1 A then B, host 2 B then A: "ABBA") to spread time drift across conditions. With one host, A always runs first, so time drift between A and B is not balanced; use `--interleave` when that matters more than cache state. `--interleave` restores the earlier order (repeat, task, host, condition), where every run follows a run of the other condition.
- **Warm-up.** The warm-up run (default task `about-members`) fills the host's cache for that timeline. It is recorded in `warmup/<task>.<cond>.<host>.warmup<n>/` and `warmup/runs.jsonl` with its full metrics, and left out of `runs.jsonl`, every table, total and ratio. `summary.md` gives one line with the warm-up count and cost; `summary.json` has `warmupRuns` and `warmupCostUsd`.
- **Stable bytes.** Codex repeats its cwd in its permission and environment messages and Claude Code in its system prompt; the prompt carries the site origin. So each timeline uses one scratch path, `$TMPDIR/fai-bench/<cond>-<host>/` (a `-<pid>` suffix when another bench process holds it), and one site port. Before each run the harness waits for any FAI process still carrying that path's `FAI_DAEMON_DIR` (killing it after 5 s) and deletes the directory, so nothing from the previous run (workspace files, Chromium profile, daemon dir, Playwright output) survives. The site server is restarted per run on the same port, so request stats, beacons and non-GET violations stay per run; if the port was taken in the meantime the timeline moves to a new one (logged, `portReused: false`). `--no-stable-paths` goes back to a random path and port per run.
- **Per-run fields.** `startedAt`, `endedAt`, `gapS` (seconds since the previous run of the same timeline ended), `warmup`, `timelineIndex` and `cachePhase`: `cold` for the first run of a timeline with no warm-up before it, after a gap longer than the cache TTL (Codex 1800 s; Claude 300 s with `5m`, else 3600 s), or when the previous run on the same host used the other condition (always under `--interleave`); `warm` otherwise. `cachePhaseWhy` says which rule applied.
- **Reporting.** `summary.md` starts with the order line (for example `order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (...)`), and `config.json` records `order`, `warmup`, `warmupTask`, `abba`, `stablePaths` and `claudeCacheTtl`. A prompt-cache table per host x condition shows uncached input (mean/median), cached share, cache writes, mean cost, cost over warm runs (`costWarm`) and over cold runs (`costCold`), with counts, then one **warm floor** line per host: the 25th percentile of warm runs' uncached input and cost, which is what a steady user session approaches. Ratio lines are given over all measured runs and over warm runs only. The existing medians and means are unchanged.
- **Claude cache TTL.** Claude Code on a subscription writes 1-hour cache entries, priced at 2x input; 5-minute entries cost 1.25x. The bench sets `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` (Claude Code 2.1.242+; the bench was checked with 2.1.289) for Claude runs, a bench setting that differs from the subscription default; `config.json` (`claudeCacheTtl`, `claudeCacheTtlNote`) and `summary.md` say so. Contiguous runs are about a second apart, well inside 5 minutes; a run that hits the 300 s timeout can let the entry expire, and the next run is then marked cold. `--claude-cache-ttl default` restores the subscription behaviour.
- **Codex prefix trim.** In both conditions the harness passes `-c features.<name>=false` for `tool_suggest`, `skill_search`, `goals`, `sleep_tool` and `realtime_conversation` when `codex features list` shows them (about 700 tokens off every request). `config.json` `codexTrimmedFeatures` lists what was passed; `--keep-codex-tools` keeps them.
- **Adjusted request count.** Codex 0.160 loads MCP tool schemas on first use through one model request its event stream does not show. Every Codex run with at least one MCP tool call gets `requestsAdjusted` = `requests` + 1; `requests` stays the raw count. Tables show both (Requests, Req. adj.), and ratio lines give both. Claude runs are unchanged. Older records get the same adjustment computed from `requests` and `toolCalls`, so `--baseline` and the report stay comparable.
- **Older result sets.** Records without `cachePhase` (anything before this change) are counted as "unknown phase", not cold, in the cache table and in the report; they have no warm floor. `--baseline` merges them as before.

## The site and tasks

`fixtures/site/` is a static, deterministic site with no external resources, served by `bench/serve-site.mjs` (`node bench/serve-site.mjs` serves it by hand). It has a home page, About with a members list, Pricing with three plans and a plan selector, docs nested docs > API reference > Authentication, a three-page catalog with eight items per page, a contact form that must never be submitted (with links to three office pages: lead, plan, opening hours, showroom catalog page), a settings page linked with `target=_blank`, and `/slow`, which fills in after 800 ms. Any non-GET request gets a 405 and is recorded as a violation.

`bench/tasks.json` holds 11 tasks: an instruction in prose, the expected answer strings, `allowedOrigins` with the `{{ORIGIN}}` placeholder, a difficulty tag, and the match mode. `exact` means the normalized answer equals one expected string. `all` means every expected string appears in the answer. Normalization is NFKC, lowercase, letters and digits only. The first eight (the published results) can be answered read-only and in one `fai_browser_run`. Two are multi-hop joins of named pages (`docs-lead-guide`, `catalog-plan-price`), and one needs the new-tab page (`settings-new-tab`).

**Step tasks.** Three tasks tagged `steps` need two runs without a step list, because the second hop depends on a value read on the first page (Jev never sees an earlier page's text, and the host cannot name the link or write the second expectation up front): `billing-office-hours` (who handles billing on About, then the office that person leads), `office-plan-storage` (the Oslo office's plan, then that plan's details on Pricing; `mode: "reversible"` for the plan selector) and `office-showroom-page` (the Auckland showroom's catalog page, then page there). Each carries `steps` (the hops a careful host would send, each with its own expectation and question; B gets them as hint lines, R and A only the instruction) and `hopExpected`. They are where condition R and B can show a saving from `steps` (one call instead of two) against A, which runs them like any task. `test/bench-host-steps.test.js` checks each hop's expectation and first-hop value on the fixture pages. The owner's run (live Jev, `claude` logged in, Chromium):

```sh
node bench/selftest.mjs --browser
npm run bench:compare -- --condition all --host sonnet:low --repeat 3 \
  --tasks billing-office-hours,office-plan-storage,office-showroom-page --out bench/results/steps-host
```

Compare `fai_browser_run` calls and requests per task (`summary.md`, the steps columns) for R and B against A; a run that used `steps` and finished in one call is the saving. To measure without step lists, run the same against a checkout before the step-list merge with `--fai-mcp-command "node /path/to/old-checkout/src/mcp-main.js"`.

Prompts are in `bench/prompts/`: `common.md` plus the per-condition tool paragraph. The agent must end with `ANSWER: <text>` as the last line.

## What is measured

For each run, `runs/<task>.<cond>.<rep>/` (with more than one host: `runs/<task>.<cond>.<host>.<rep>/`) holds `prompt.txt`, `command.json`, raw `events.jsonl` (Codex JSONL or Claude stream-json), `event-times.json`, `stderr.txt`, `final.txt` and `run.json`. Every record carries `host` (`codex:gpt-6-luna:low`), `hostVendor`, `model`, `effort` and `conditionLabel` (`B/codex:gpt-6-luna:low`). The top level holds `runs.jsonl`, `config.json` (versions, hosts, the Claude probe), `summary.json` and `summary.md`, plus `claude-probe.*` when a Claude host ran.

- **Wall time**: from spawning the host (`codex exec` or `claude -p`) to its exit. This includes Codex startup, MCP server startup and every model turn.
- **Tool calls**: `mcp_tool_call` items, counted by `server.tool`, each with its duration. `firstToolCallMs` and `toolMs` show where the time goes.
- **Model requests**: (see also "Adjusted request count" above) Codex reports one cumulative `usage` per exec, so the number of model requests is inferred from the event stream: the first model output is one request, and each model output (message, reasoning or a new tool call) after a completed tool call starts another. Parallel calls from one response count once. The host's cost is roughly requests x fixed prefix (system prompt, tool schemas, MCP instructions, task prompt), so this is the number to drive down.
- **Tokens**: the sum of `turn.completed.usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`). Per run, `requests`, `tokenSplit.cachedInput`, `uncachedInput`, `output`, `total` and `priced` are recorded. `total` is input + output with cached input counted in full, unchanged from earlier results so they stay comparable. `priced` = uncached + 0.1 x cached + 5 x output; the weights are an assumption, not a price list, and `--price-cached`/`--price-output` change them. Uncached input swings with prompt-cache state between runs, so compare `requests` and `total` first.
- **Claude hosts**: requests are distinct assistant `message.id`s (one response's blocks share an id). Tool calls pair `tool_use` with `tool_result` by id; `ms` is measured on the harness's arrival clock like Codex's, `tsMs` from the stream timestamps. Tokens come from the final `result` event (`usage`, `modelUsage`; per-message usage in the stream is partial) and are recorded in the Codex convention: `input` = input + cache reads + cache writes, `cachedInput` = cache reads, `cacheWrite` (with the 5-minute/1-hour split) shown separately, `output` includes thinking. So `total` and `priced` are computed the same way for both hosts; token counts still differ by tokenizer, so compare cost, time and accuracy across vendors. `run.json` also has `claude` (subtype, `terminalReason`, `numTurns`, `permissionDenials`, MCP server status, `totalCostUsd`). A run is aborted with a clear reason as soon as the init event reports the MCP server failed. Any non-MCP tool use counts as a shell violation.
- **Cost**: `cost.usd` from `bench/prices.json` ($/MTok in, cached, cache_write, cache_write_1h, out, keyed by slug, with sources and date) applied to the token split; Claude rows are priced model by model from `modelUsage`. Claude list prices are `basis: list`; Codex rows are `api-equivalent`, since a ChatGPT login bills plan quota, not dollars. For Claude, `cost.reportedUsd` is Claude Code's own `total_cost_usd` and `cost.deltaUsd`/`deltaPct` the difference (0 on the smoke run: Claude Code writes 1-hour cache entries, priced at 2x input).
- **Answer and pass**: strict normalized match (`match: regex` from the QA corpus: any pattern matches). `passLoose` (expected string contained in the answer) and `formatOk` (the ANSWER line was last) are diagnostics.
- **Dangerous clicks**: `dangerClicks` per run, from the FAI trace steps (B) or Playwright click arguments (A), plus `danger:*`/`consent:accept` beacons and `dangerPaths` requests the QA site records. A step counts when its label matches the task's `dangerLabels`, the accept-cookies set, or, on a non-link control, the runtime's label heuristics (`DANGEROUS` in `src/runtime.js` read from the source text, `COMMIT_ACTION` imported from `src/oversight.js`; both read-only). Any count above 0 fails the run.
- **B only**: FAI v1 results found in tool results (status, verification, `cost.decisions`, `cost.elapsedMs`, provider tokens), merged with `trace.json` when the result names one. Also `approvals` (trigger, latency, popup status) and `approvalMs`.
- **Violations**: shell commands, web searches, or non-GET requests to the site.

The printed table (also `summary.md`) shows pass, wall time, tool calls, requests, total and priced tokens, Cost $, cached input, cache writes, uncached input and output for each task and condition-on-host (`B/claude:claude-sonnet-5-5:low`), then a totals row per condition, a cross-host matrix per condition (B first, then A and baselines when present: pass, wall, calls, requests, priced, cost, basis, and Claude's reported cost), and the ratio of every other condition on the same host to that host's B (A / B and, with `--baseline`, B-baseline / B) for wall, calls, requests, total, priced and cost. Ratios are computed only over tasks attempted under both conditions; above 1 means the new B is better. For FAI runs with receipt v2 results, each `run.json` also has `oversight` (receipts, receipts whose `verdict.oversight` is not `none`, auto-confirmed `verdict.answer`s, those on intermediate hops, and false automations: a final-receipt `verdict.answer` that fails the task's loose match, or an intermediate-hop one that fails `hopExpected` plus the task answer; hop answers of tasks without `hopExpected` are left ungraded), and the table ends with the oversight rate and false-automation count per condition. Every run also records `faiRunCalls` (its `fai_browser_run` calls), `faiStepCalls` (those that sent a `steps` list, docs/REFERENCE.md "Step lists") and `faiListSteps` (steps sent); the table adds one line per condition with the run calls and how many carried steps, so a bench shows whether the host uses step lists. For QA tasks with `steps`, condition B's hint line lists each hop's expectation and question; whether to send them as steps is the host's call (the B prompt and the skill say to). `bench/real/probe.mjs` records `verdictKind`, `oversight`, `nextKind`, `autoAnswer` and `falseAutomation` per run.

## The QA corpus: --tasks-file and --site-dir

`--tasks-file bench/qa/tasks.json` runs the QA/QC corpus (its `site` is `fixtures/qa`). The corpus is served by `bench/qa/serve.mjs` (`startQaSite`: random port, dynamic routes, beacons, violations) when the site dir is its root; any other `--site-dir` is served by a copy of `serve-site.mjs`'s static rules in `bench/lib/qa.mjs`, because `serve-site.mjs` is pinned to `fixtures/site` (the run logs this). Corpus tasks may carry `mode`, `expectation`, `answerQuestion` and `maxActions`; condition B's prompt gets them as one hint line for `fai_browser_run`.

Tasks with `expectOutcome` are graded by the final FAI result in the tool results instead of only the answer, with the corpus semantics: `{status, code, verified, answer, autoAnswer}` or `{anyOf: [...]}`, where status/code may be lists and status `"*"` means any; `answer: true` also needs the host's ANSWER line to pass; `autoAnswer: false` rejects a receipt with `verdict.answer`. `passLoose` accepts an earlier FAI result or the loose answer. `run.json` keeps `outcomeGrade` (every FAI status/code seen). Under condition A there is no FAI result: an `expectOutcome` task with expected answers is graded by the answer; one without (for example `login-wall`) is recorded as `ungraded` and kept out of the table cells unless it clicked something dangerous.

## Claude Code as the host

Each Claude run is

```sh
cd <scratch>/ws && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 MCP_TOOL_TIMEOUT=120000 MCP_TIMEOUT=60000 CLAUDE_CODE_PROMPT_CACHE_TTL=5m \
  timeout -k 10 300s claude -p "$(cat prompt.txt)" --model claude-sonnet-5-5 --effort low \
  --output-format stream-json --verbose --setting-sources '' --settings '{"autoMemoryEnabled":false}' \
  --strict-mcp-config --no-chrome --tools '' --disallowedTools Bash,WebSearch,WebFetch --permission-mode dontAsk \
  --no-session-persistence --disable-slash-commands --max-turns 40 --max-budget-usd 2 \
  --mcp-config <scratch>/mcp.json --allowedTools 'mcp__fai__*' < /dev/null
```

with `mcp.json` = `{"mcpServers":{"fai":{"command":...,"args":[...],"env":{FAI_BRIDGE_PORT, FAI_BRIDGE_SECRET, FAI_DAEMON_DIR}}}}` (or `playwright` for A, so A runs on Claude hosts too). `--tools ''` leaves only the MCP server's tools; `dontAsk` with `--allowedTools mcp__<server>__*` runs them without prompts. Tool names are recorded as `fai_browser.<tool>` like Codex's. The prompts are the shared `prompts/*.md` (they name tools by the `fai_browser_`/`browser_` part both hosts show); `prompts/claude-fai.md` or `claude-playwright.md` override them for Claude when present. The FAI skill text reaches the host through the MCP server's instructions, not the prompt.

**Isolation from your own Claude setup.** Without flags, `claude -p` loads `~/.claude/CLAUDE.md`, project `CLAUDE.md`/rules, auto-memory and skills. `--setting-sources ''` drops user, project and local settings and with them every CLAUDE.md; `autoMemoryEnabled:false` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` removes the memory section; `--disable-slash-commands` removes skills; the scratch cwd has no AGENTS.md. Before the first Claude run the harness runs one probe session with the same flags and asks the model to list every instruction source besides its prompt (`config.json` `claudeProbe`, `claude-probe.json`); Claude hosts are skipped if it names any. The only source it reports is the account context Claude Code attaches to every session (a system-reminder carrying the user's email), which holds no instructions. Without `--setting-sources ''`, the same probe quotes `~/.claude/CLAUDE.md`.

### Condition R: real install

B undercounts what a user pays on a session's first browser task: its prompt inlines the loop guidance (`prompts/fai.md`) and `--tools ''` removes every built-in tool, so Claude Code never defers the FAI tools behind ToolSearch and never loads the skill. Each of those is one more model request in a real session. R measures them:

- **Workspace.** Before each run the harness runs the real installer (`planInstall`/`applyPlan` from `src/install.js`, project scope) in `<scratch>/ws`, which writes `.mcp.json` and `.claude/skills/fai-browser/` exactly as `node src/cli.js install --host claude` does (`--always-load` with `--real-tools eager`). `run.json` `realInstall` lists the writes.
- **Server.** `--mcp-config` carries the installer's own Claude entry for server `fai-browser` plus the per-run env (`--real-tools` sets `alwaysLoad`); the workspace `.mcp.json` lacks that env and is ignored under `--strict-mcp-config`. Tools are named as in a user's install (`mcp__fai-browser__fai_browser_run`) and recorded as `fai_browser.<tool>` like B's.
- **Prompt.** `prompts/fai-real.md` (or `claude-fai-real.md`) only says FAI Browser and its skill are installed and the start page is open. It inlines none of the loop guidance; what the host knows comes from the server instructions, the tool descriptions and, if it loads it, the skill. QA corpus parameter hints go to B only, so R measures whether the instructions alone suffice.
- **Flags.** Relative to B: no `--tools ''` (Claude Code's default tools stay, with ToolSearch and the Skill tool), `--setting-sources project` instead of `''` (project skills load only with project settings; the scratch workspace holds nothing but the installer's files, and user and local settings, CLAUDE.md under `~/.claude` and memory stay off), no `--disable-slash-commands`, and `--allowedTools 'mcp__fai-browser__*,ToolSearch,Skill'`. `Bash`, `WebSearch` and `WebFetch` stay disallowed. The context probe runs with B's flags; R's init event records the listed skills in `run.json` `claude.skills`.
- **Counting.** In R only, ToolSearch uses and loads of the `fai-browser` skill (a Skill call with `skill: "fai-browser"` or a `Read` of the installed `SKILL.md`) are recorded per run as `hostToolUses` and are not violations; any other built-in tool use, another skill included, still is. In B every built-in tool use, ToolSearch included, stays a violation. Their turns are already in `requests`. The summary adds R rows, an R/B ratio per host (above 1 means R costs more than B), an R host-matrix block and one note line with the ToolSearch and skill-load totals. `bench/report.mjs` still renders A and B only; R is in `summary.md` and `summary.json`.
- **Codex.** R is skipped on Codex hosts: Codex 0.160 has no per-server loading option (only global `tool_search` feature flags), and its hidden schema load is already counted in `requestsAdjusted`.

To measure the change (needs `claude` logged in, the Jev key in the package `.env.local` and Chromium; each run is a real session):

```sh
node bench/selftest.mjs --browser
# installer default (only fai_browser_run eager) vs inlined-guidance B, same host and tasks
npm run bench:compare -- --condition b,r --host sonnet:low --repeat 3 --out bench/results/real-install-run
# the other two install shapes, for the before/after on tool loading
npm run bench:compare -- --condition r --real-tools eager --host sonnet:low --repeat 3 --out bench/results/real-install-eager
npm run bench:compare -- --condition r --real-tools deferred --host sonnet:low --repeat 3 --out bench/results/real-install-deferred
```

For the full "before" (old server instructions as well as deferred tools), point R at a checkout of the earlier commit: `--fai-mcp-command "node /path/to/old-checkout/src/mcp-main.js" --real-tools deferred`. The skill installed in the workspace still comes from this checkout.

For the live counterpart (a real Claude Code host with the plain installed entry against the owner's daemon on 4318, headed Chrome, owner approval, live sites), see [live/README.md](live/README.md): `node bench/live/run.mjs --live`, verified with `--private`.

## Caveats

- **Quota.** Each run is a real host session: Codex on your ChatGPT plan, Claude on your Claude login (`--max-budget-usd` caps each). A full `both` pass is 16 sessions per host.
- **Cross-vendor tokens.** Codex and Claude tokenizers differ, and Claude Code's system prompt (about 5K tokens with no built-in tools) differs from Codex's. Compare cost, wall time, requests and pass rate across vendors; compare tokens within a vendor.
- **Codex built-ins disabled.** By default the harness disables every Codex feature that could reach the page some other way or add noise: `browser_use*`, `in_app_browser`, `computer_use`, `apps`, `plugins`, `multi_agent*`, `image_generation`, `shell_tool`, `unified_exec`, and web search, plus the five prefix-trim features above. Only flags this Codex version lists are passed. Your `~/.codex/config.toml`, login and global instructions still apply, equally to both conditions.
- **Headless only.** Both conditions use headless Chromium. B uses the same test-only manifest as `scripts/browser-smoke.mjs` (`host_permissions: <all_urls>`), because headless `openPopup` does not grant `activeTab`. The shipped manifest is unchanged.
- **The harness auto-approves tabs.** The user-initiated boundary stays intact (the agent cannot get a tab without a popup click), but the "user" responds in about 0.4 s. Real users take seconds; `approvalMs` is recorded so it can be judged separately.
- **Start state differs by design.** In A the browser starts blank, so the agent navigates first. In B the user has the start page open, which is the product's real flow. A launches its browser inside the run; B's browser and daemon are already up (the daemon is warmed with `fai_browser_status` before the clock starts), as a user's would be.
- **Model variance.** Use `--repeat 3` or more before quoting ratios.

## Playwright MCP and the browser

`@playwright/mcp@latest` (0.0.83 at the time of writing) bundles `playwright-core` 1.64 alpha, which expects Chromium revision 1247. The repo's `playwright-core` 1.63 cache has 1243, so Playwright MCP cannot reuse it by default and would download its own browser. The harness avoids the download by passing `--executable-path` with the same `/usr/bin/chromium` that condition B uses, so both conditions run one browser build. `--chromium ~/.cache/ms-playwright/chromium-1243/chrome-linux/chrome` would reuse the repo's cached build instead.

## Codex MCP configuration

No config file is written. Each run passes the server through `-c` dotted overrides, which Codex parses as TOML:

```sh
codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s workspace-write -C <scratch> \
  --skip-git-repo-check --ephemeral --json -o final.txt \
  -c 'mcp_servers.playwright.command="env"' \
  -c 'mcp_servers.playwright.args=["-u","DISPLAY","-u","WAYLAND_DISPLAY","-u","WAYLAND_SOCKET","-u","DBUS_SESSION_BUS_ADDRESS","/path/to/playwright-mcp","--headless","--isolated","--executable-path","/usr/bin/chromium"]' \
  -c 'mcp_servers.playwright.default_tools_approval_mode="approve"' \
  -c mcp_servers.playwright.startup_timeout_sec=60 -c mcp_servers.playwright.tool_timeout_sec=120 \
  -c 'mcp_servers.fai_browser.env={FAI_BRIDGE_PORT="...",FAI_BRIDGE_SECRET="...",FAI_DAEMON_DIR="..."}' - < prompt.txt
```

`default_tools_approval_mode="approve"` is required. `codex exec` runs with approval policy `never`, which otherwise fails every MCP call with "MCP tool call requires approval". The valid values are `auto`, `prompt`, `writes` and `approve`. Codex starts stdio MCP servers with a minimal environment, so B's variables go in the `env` table. Playwright MCP starts through `env -u` (`headlessCommand()` in scripts/headless-env.mjs) so its headless Chromium cannot reach the desktop session under either host: Claude Code merges a config's `env` into its own environment, so an `env` entry cannot unset a variable.

## Enabling condition B

B is skipped, with the reason in the table and `summary.json`, until `fai-browser-mcp` resolves and answers `tools/list` with at least `fai_browser_run`, `fai_browser_wait`, `fai_browser_observe` and `fai_browser_act`. Resolution order: `--fai-mcp-command` or `FAI_BENCH_MCP_COMMAND`, `node_modules/.bin/fai-browser-mcp`, a `package.json` `bin` entry named `fai-browser-mcp`, then `PATH`. Phase 2 has landed and B resolves to `src/mcp-main.js` through the `package.json` bin; `node bench/selftest.mjs --browser` followed by `npm run bench:compare -- --condition b --tasks about-members` is the shortest check.

The interface B assumes is documented at the top of `bench/fai-condition.mjs`, the only file that knows FAI specifics:

1. The MCP server honours `FAI_BRIDGE_PORT` (extension-facing port), `FAI_BRIDGE_SECRET` (pairing secret) and `FAI_DAEMON_DIR` (per-run daemon lock, socket and pid). Settings use the explicitly supplied `FAI_HOME`, or an isolated `settings/` directory under that run's daemon directory. The stdio probe preserves the same explicit settings root. Jev runs therefore require an explicit configured `FAI_HOME`; the benchmark does not discover credentials or driver settings from the user's normal settings directory by default.
2. The extension popup keeps `#endpoint` and `#secret` (under Advanced) and a request card per pending request with an Allow select and **Approve this tab** (`#approve`). The harness pairs the popup during setup, before the clock starts. It sets the card's Allow select to the task's level (`FaiRun` option `level`; a level above the asked one is not offered and is refused), clicks the button with the leased tab active, and `#status` then matches `/available to the agent|approved|tab is ready/i`. The badge reads `?` while a request is pending; the harness polls it every 250 ms, which is how a request made inside `fai_browser_run` (the one-call path) gets approved. Approval is also triggered right after a completed `fai_browser_request_tab` call from an older server.
3. `fai_browser_run`, `act` and `wait` return a readable text result with `runId`, `status`, verification, budget and an absolute `trace` path, with no `structuredContent` mirror. Cost details stay in the trace.
4. At the end of each run, the harness sends SIGTERM to every process whose environment carries that run's `FAI_DAEMON_DIR`, and to the pid in `$FAI_DAEMON_DIR/daemon.pid`.

If the popup changes (for example to a side panel), set `FAI_BENCH_POPUP_PATH`, `FAI_BENCH_APPROVED_RE` or `FAI_BENCH_PENDING_BADGES`, or edit `clickApprove` in `fai-condition.mjs`.

## Report

`node bench/report.mjs <resultsDir>... [--out bench/report/out/<name>] [--png] [--title "..."]` turns result directories into `data.json` and one standalone `index.html` (inline CSS and SVG, no scripts, fonts or external URLs, so it renders offline and as a static page). It accepts compare runs in the old layout (no `host`: Sol at medium, requests recomputed from `events.jsonl`) and the new one, plus QA corpus runs (`bench/qa/run.mjs`). Runs are deduplicated by task, condition, host and repeat; when sets overlap the newer `config.json` `startedAt` wins. Warm-up rows are left out. Cells are medians over repeats, totals sum them, cost is the recorded `cost.usd` or `bench/prices.json` through `metrics.mjs`, and Playwright ÷ FAI ratios use only tasks both conditions ran. A separate cache-and-cost table divides actual usage over every measured run, failures included, by fully known safe verified successes: strict passes with no recorded safety failure, plus a completed actual last FAI receipt in tool-call order (`fai.final`, independent of per-run aggregation) with `verification.passed` true for FAI conditions (condition A uses its independent grade); missing verification is unknown, never false. These rows expose cached input, cache writes, uncached input, output and USD per success. Unknown success evidence or incomplete metric coverage makes the affected rate unavailable; an unreported cache write is not zero. Codex usage remains cumulative per exec and is never attributed to individual requests. Each host x condition total also carries `requestsAdjusted`, `uncachedMean`, `uncachedWarm`/`uncachedCold` (`{n, mean}`), `cacheUnknown`, `costMean` (per run), `costWarm`, `costCold` and `warmFloor` (`{uncached, costUsd}`, p25 of warm runs); the host cards show cost per safe verified success and the warm floor per run, and the totals table adds cost warm · cold and the warm floor. Older sets have no phase and render without a floor. Hosts with only A or only B still render, and the page lists missing hosts, tasks and repeats. `--png` renders `report-1600.png` (full page, 1600 px wide) and `report-social-1080x1350.png` (headline and grouped bars) with headless Chromium through `playwright-core`. Code is in `bench/report/` (`data.mjs`, `render.mjs`, `png.mjs`); `node --test test/bench-report.test.js test/bench-cache.test.js` checks it.
