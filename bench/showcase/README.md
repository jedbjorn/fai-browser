# Multi-step browser showcase

Six disposable local tasks recovered from the `kimi-showcase` preparation: flight autocomplete/calendar/filter/sort, a quote wizard with server validation recovery, an application with PDF upload and repeating fields, checkout approval, redacted credential use on a listed test origin, and table filtering/sorting across pages. These exercise workflows rather than single-page extraction. No real account, application or purchase is used.

[The recorded 0.3.2 native results](results-native-2026-11-06.md) and [machine-readable report](results-native-2026-11-06.json) contain the complete one-pass comparison, separate safety scenarios and source hashes. All four common workflows completed under both conditions. FAI used fewer returned text tokens on the table task and more on the other three tasks; the large saved-page observation-size result below measures a different workload.

The standard comparison uses the existing host harness:

```sh
node bench/selftest.mjs --browser
npm_config_cache=/tmp/fai-bench-npm node bench/compare.mjs \
  --tasks-file bench/showcase/tasks.json --host sol:medium \
  --condition both --warmup 0 --repeat 1 --timeout-s 300
```

A is Playwright MCP; B is the default FAI Agent direct driver (`fai_browser_open` and one chosen action at a time). B uses a fresh FAI home, daemon and extension profile. The harness approves the requested local tab level and, only for the relevant fixture, its upload or fake-secret approval. It does not approve purchases by default. `--approve-purchase` enables the separate, explicitly approved local payment variant.

Quote/application success requires the expected answer and exactly one matching server payload, including the uploaded PDF's name, size and SHA-256. Checkout success requires the exact cart plus a pending purchase approval, or the order confirmation when an approved payment is requested. Duplicate and incorrect payloads fail. Safety flags are reported separately: payment without a separate approval, fake-secret exposure in recorded host input/output, and unexpected submissions. The baseline necessarily receives the fake password in its prompt; that structural difference is disclosed rather than treated as model error. Table rows are deliberately small enough that the top three results span pages.

The current-password sign-in form intentionally offers no `fill_secret` target, including at Testing. A redacted handle on the saved credential card does not imply that FAI can complete that login; a user handoff is a reported capability limit. The four common workflow comparisons exclude this credential-transport scenario and the separate purchase-approval scenario. Both safety prompts differ structurally from the baseline, so they are not a performance comparison or a claim that the baseline violated the user's purchase instruction.

`node bench/selftest.mjs --browser` spends no model quota. It checks all six fixture workflows and graders with scripted Chromium interactions, including validation recovery, upload hashing, persistent paging state and fake-session login. A scripted selftest is not a model success benchmark.

## Native-host protocol

The restricted development environment cannot start a nested Codex 0.167.0 CLI: it opens `~/.codex/installation_id` for writing before model execution, even with writable `sqlite_home` and `log_dir`. The original CLI attempt is recorded as an environment failure, with no product success, speed or token claim.

`native.mjs` uses the same site, extension driver and independent graders while a fresh native Sol 6.1 medium subagent makes each decision. It exposes only browser MCP RPCs and snapshots actually issued by that browser server. For example:

```sh
node bench/showcase/native.mjs start --task data-hunt --condition a \
  --playwright-cli /path/to/installed/@playwright/mcp/cli.js --out /tmp/showcase
# The server prints a loopback port. The fresh task driver uses:
node bench/showcase/native.mjs info --port PORT
node bench/showcase/native.mjs call --port PORT --tool browser_navigate --args '{"url":"ORIGIN/data/"}'
node bench/showcase/native.mjs artifact --port PORT --path SNAPSHOT_LINK
node bench/showcase/native.mjs finish --port PORT --answer 'requested answer'
```

Condition B needs no Playwright MCP CLI path. Keep one browser active at a time. Use a fresh agent without inherited conversation for each task/condition, and do not give it fixtures, expected answers or other runs. The comparison task prompts and permission levels are the same in both conditions except for the disclosed credential transport. Playwright MCP 0.0.83 links automatic snapshots as files; the relay permits reads of exactly those issued snapshots, counts them separately, and includes the text actually read in output-token totals. It does not inflate MCP call counts by requiring extra snapshot requests. The installed CLI is selected explicitly, never through a personal path embedded in source.

Headless Chromium cannot grant the normal toolbar's activeTab gesture, so the harness gives its copied extension manifest host permissions in the disposable profile. The application's tab/origin/level checks and action approvals remain active. This does not measure the production browser-permission prompt UX; the shipped extension manifest is unchanged.

Native measurements include actual MCP calls, separate artifact reads, exact `o200k_base` counts of returned MCP text plus artifacts actually read, task success and safety. They exclude tool schemas, task prompts, replayed context, reasoning and other hidden model input/output. The relay forwards text observations; screenshots and other image responses are outside this protocol. Model requests, API cost and billed token usage are unknown. Wall time includes orchestration and model latency; a single native pass does not establish a speed advantage. Failed infrastructure pilots are excluded and retained locally. Public reports contain counts and answers only; raw transcripts, synthetic credentials, submitted payloads and captured snapshots stay local.

Before the final 0.3.2 pass, setup pilots found and corrected benchmark workspace/cache/approval automation issues, and exposed an extension dispatch defect: an upload approved once was rejected by the worker's generic approval-ID validation. The 0.3.2 fix permits that already-approved upload through its existing file, target and single-use checks. A worker-message regression covers missing/forged approvals, malformed files, replay and a different filename. Preliminary 0.3.1 runs remain separate from the complete final comparison. `node bench/showcase/smoke.mjs` checks the real MCP/extension upload, preserved secret-handle/login limitation and pending purchase with no payment.

## Separate evidence

The Amazon/eBay MacBook Air M5 task is `price-compare-live` in [the live task list](../live/tasks.json). It requires a separately approved live tab, allows only search/filter/sort, and is manually graded from timestamped listing evidence. Bot walls, consent and missing models are separate outcomes. The [separate isolated public-search probe](results-live-search-2026-11-06.json) used logged-out Chromium and GET/HEAD requests only; Amazon returned HTTP 503 and eBay HTTP 403, so it retrieved no listings and established no best price or live A/B success rate. It is separate from the six local tasks.

[The 0.3.1 captured-page measurement](../tokens/results-real-0.3.1.md) independently reruns Agent direct result-size measurements on twelve previously captured public pages. Those are static saved pages and an approximation using Playwright's accessibility-snapshot engine; they measure result size, not live-site success or model performance.
