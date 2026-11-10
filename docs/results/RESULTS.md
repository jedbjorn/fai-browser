# Before/after: delegating browser work

> Note: the experimental Jev autopilot (TypeSafe provider, `fai_browser_run`, step lists, site profiles) this document describes was removed in Unreleased (after 0.6.2). Kept as history.

FAI Browser lets a coding agent delegate a bounded browser task to a local browser worker through MCP. It returns a receipt with the observed answer, verification evidence, and the next action for the host or user.

> **What these numbers measure.** Everything on this page measures the experimental **Jev autopilot** (an optional TypeSafe Jev
> model drives instead of your agent, so the host makes one call per task) against Playwright MCP, on local fixture sites, not
> public websites. They do **not** describe Agent direct, the default mode, where your agent chooses each action; a comparable
> measurement for that mode is planned. The harness approves the tab request automatically, so a live user adds approval time.

With Playwright MCP, the host makes the browser calls and interprets each result. With FAI Browser, it delegates the task and responds to the worker's receipt when further judgment is needed.

Across six host models, FAI's wall-time speedup is **1.24×–1.73×**, with lower priced cost for every host in this fixture benchmark (**1.19×–2.28×** cheaper). Tool calls fall by **4.3×–6.0×**, and recorded model requests by **2.4×–3.5×** (**2.35×–2.69×** once Codex's hidden schema-load request is counted).

FAI with Opus 5.5 averages **8.6 s/task** over the per-task medians; Sonnet 5.5 is the fastest host/condition combination at **7.1 s/task**. These are suite averages of medians, not the best individual task times. Every host passes 24/24 with FAI. See the [report data](../../bench/report/out/all-hosts/data.json) for the numbers behind the tables and graphics. [docs/TESTED.md](../TESTED.md) describes the fixture site, the eight tasks, the QA corpus and the real-site probe.

Luna and Terra are the cheapest host tiers. On the first matrix (2026-10-04 midday) they passed 21/24 and 17/24 with FAI: the receipt's answer was a whole page line that cheap hosts copied verbatim, and Terra sometimes failed to find the MCP tool behind Codex's tool search. Both were FAI-side fixes (the answer value is now cut from the line; the skill and tool text name the tool exactly). The clean rerun (`2026-10-04-matrix-3-weak-b`, contiguous timeline, 3 repeats, on the build that also includes the guardrail pass) passes 24/24 on both: Luna 13.5 s/task at $0.0014, Terra 12.8 s/task at $0.020. Their Playwright MCP baselines are from the earlier matrix (`2026-10-04-matrix-2`); the baseline does not use FAI, so those fixes do not affect it.

<!-- results:begin -->
## Measured comparison

8 local fixture tasks; per-task medians of up to 3 repeats. Suite totals sum those medians; per-task values divide by tasks run. Pass counts include all graded repeats, including failures. The current harness uses a contiguous timeline per host × condition with an excluded warm-up. This report can also include older runs with unknown cache phase and targeted reruns without warm-up; it is not a single uniform timeline experiment. Wall time includes host start-up through exit. Prices come from bench/prices.json (2026-10-04); Claude costs use list prices and Codex costs are API-equivalent, not subscription charges. Requests are shown both as recorded and adjusted: Codex adds one request per run with a tool call for the hidden MCP schema load; Claude is unchanged. A/B ratios compare Playwright MCP (A) with FAI Browser (B) on shared tasks; values above 1 favour FAI.

### GPT-6.1 Sol (medium)

| Condition | Pass | Wall s | Tool calls | Requests | Requests adjusted | Cost $ | A/B wall | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | 24/24 | 209.7 | 47 | 55 | 63 | 0.277045 | — | — |
| FAI Browser | 24/24 | 150.2 | 8 | 16 | 24 | 0.233286 | 1.40× | 1.19× |

| Condition | Tokens (suite) | Priced tokens (suite) | Warm mean $/run (n) | Cold mean $/run (n) |
| --- | --- | --- | --- | --- |
| Playwright MCP | 557719 | 160992.8 | — | — |
| FAI Browser | 290012 | 127331.0 | — | — |

### GPT-6 Astra (medium)

| Condition | Pass | Wall s | Tool calls | Requests | Requests adjusted | Cost $ | A/B wall | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | 24/24 | 191.1 | 46 | 54 | 62 | 1.514270 | — | — |
| FAI Browser | 24/24 | 141.2 | 8 | 16 | 24 | 1.211772 | 1.35× | 1.25× |

| Condition | Tokens (suite) | Priced tokens (suite) | Warm mean $/run (n) | Cold mean $/run (n) |
| --- | --- | --- | --- | --- |
| Playwright MCP | 553973 | 151427.0 | — | — |
| FAI Browser | 288396 | 121177.2 | — | — |

### Claude Opus 5.5 (medium)

| Condition | Pass | Wall s | Tool calls | Requests | Requests adjusted | Cost $ | A/B wall | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | 24/24 | 104.9 | 39 | 40 | 40 | 0.345942 | — | — |
| FAI Browser | 24/24 | 68.7 | 9 | 17 | 17 | 0.274439 | 1.53× | 1.26× |

| Condition | Tokens (suite) | Priced tokens (suite) | Warm mean $/run (n) | Cold mean $/run (n) |
| --- | --- | --- | --- | --- |
| Playwright MCP | 416295 | 86693.8 | — | — |
| FAI Browser | 119719 | 55422.0 | — | — |

### Claude Sonnet 5.5 (medium)

| Condition | Pass | Wall s | Tool calls | Requests | Requests adjusted | Cost $ | A/B wall | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | 24/24 | 70.5 | 41 | 43 | 43 | 0.170554 | — | — |
| FAI Browser | 24/24 | 56.8 | 8 | 16 | 16 | 0.074857 | 1.24× | 2.28× |

| Condition | Tokens (suite) | Priced tokens (suite) | Warm mean $/run (n) | Cold mean $/run (n) |
| --- | --- | --- | --- | --- |
| Playwright MCP | 454895 | 85277.1 | 0.021316 (24) | — |
| FAI Browser | 110666 | 37428.4 | 0.010346 (24) | — |

### GPT-6 Luna (medium)

| Condition | Pass | Wall s | Tool calls | Requests | Requests adjusted | Cost $ | A/B wall | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | 23/24 | 153.6 | 47 | 55 | 63 | 0.015627 | — | — |
| FAI Browser | 24/24 | 108.3 | 10 | 18 | 26 | 0.011187 | 1.42× | 1.40× |

| Condition | Tokens (suite) | Priced tokens (suite) | Warm mean $/run (n) | Cold mean $/run (n) |
| --- | --- | --- | --- | --- |
| Playwright MCP | 666790 | 156272.2 | 0.002007 (24) | — |
| FAI Browser | 293490 | 111865.4 | 0.001311 (24) | — |

### GPT-5.6 Terra (medium)

| Condition | Pass | Wall s | Tool calls | Requests | Requests adjusted | Cost $ | A/B wall | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Playwright MCP | 24/24 | 177.2 | 48 | 56 | 64 | 0.357528 | — | — |
| FAI Browser | 24/24 | 102.4 | 8 | 16 | 24 | 0.160570 | 1.73× | 2.23× |

| Condition | Tokens (suite) | Priced tokens (suite) | Warm mean $/run (n) | Cold mean $/run (n) |
| --- | --- | --- | --- | --- |
| Playwright MCP | 771547 | 175659.0 | 0.045132 (24) | — |
| FAI Browser | 242492 | 78413.0 | 0.022230 (24) | — |

### Across hosts

Per-task values below are suite totals divided by tasks run. Each host has its own price; no cross-model cost average is implied.

| Host | Pass A / B | Wall s/task A / B | Cost $/task A / B | A/B wall | A/B calls | A/B requests raw / adjusted | A/B cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GPT-6.1 Sol | 24/24 / 24/24 | 26.2 / 18.8 | 0.034631 / 0.029161 | 1.40× | 5.88× | 3.44× / 2.63× | 1.19× |
| GPT-6 Astra | 24/24 / 24/24 | 23.9 / 17.6 | 0.189284 / 0.151471 | 1.35× | 5.75× | 3.38× / 2.58× | 1.25× |
| Claude Opus 5.5 | 24/24 / 24/24 | 13.1 / 8.6 | 0.043243 / 0.034305 | 1.53× | 4.33× | 2.35× / 2.35× | 1.26× |
| Claude Sonnet 5.5 | 24/24 / 24/24 | 8.8 / 7.1 | 0.021319 / 0.009357 | 1.24× | 5.13× | 2.69× / 2.69× | 2.28× |
| GPT-6 Luna | 23/24 / 24/24 | 19.2 / 13.5 | 0.001953 / 0.001398 | 1.42× | 4.70× | 3.06× / 2.42× | 1.40× |
| GPT-5.6 Terra | 24/24 / 24/24 | 22.1 / 12.8 | 0.044691 / 0.020071 | 1.73× | 6.00× | 3.50× / 2.67× | 2.23× |

Priced tokens are weighted equivalents (uncached input × 1, cached input × 0.1, cache write × 1.25, output × 5), not dollar prices. Warm/cold costs are means of individual runs, not suite medians; missing phases are shown as —. A cold sample is not necessarily more expensive when the tasks differ.

Sources: `2026-10-04-matrix-1`, `2026-10-04-matrix-1-baseline`, `2026-10-04-matrix-2`, `2026-10-04-matrix-3-weak-b`. Overlapping task/host/condition/repeat records use the newer result.
<!-- results:end -->

## Earlier milestones

These are separate checkpoints, not extra samples in the six-host comparison.

- The 2026-10-03 Sol milestone reports FAI at **139.6 s** versus Playwright MCP at **174.7 s** for the eight-task suite, with **9 vs 47 tool calls** and **17 vs 55 recorded model requests**. The saved baseline has 14 attempts and FAI has 24, so this is an earlier development comparison with unequal repeat coverage. [Summary](../../bench/results/2026-10-03T23-35-50-786/summary.md).
- The successful oversight pass reduces FAI to **8 calls and 16 recorded requests**, with **0 false automations** and 24/24 task attempts passing. [Summary](../../bench/results/2026-10-04-oversight-2/summary.md).
- Jev guidance evaluation accuracy rises from **0.863 to 0.949**, comparing the `base` and `all` configurations. Summary (removed).
- The guardrail pass (2026-10-04, after the six-host matrix) adds a configurable guardrail policy (a non-removable core plus per-request and config additions, rendered as the mechanical check in both runtime and extension and as the policy text Jev reads) and a Jev commit check that vetoes generic-label commit buttons in reversible mode. QA corpus **74/74 with 0 danger clicks** after the adversarial pass; Jev decision eval **0.922** over 68 cases with **0 commit false positives and 0 false vetoes**. [Corpus summary](../../bench/results/qa-2026-10-04T15-49-50-364Z-post-codex6/summary.md).
- The QA corpus passes **64/64 with 0 danger clicks** in the weak-host-value run. This exercises the FAI runtime and Jev directly, without a host model. The earlier full corpus passed 58/64; the separate machinery run later passed 128/128 across two repeats. [64-task summary](../../bench/results/qa-2026-10-04T10-58-28-634Z-weak-host-value/summary.md), [earlier full run](../../bench/results/qa-2026-10-04T08-59-59-162Z-full/summary.md), [two-repeat run](../../bench/results/qa-2026-10-04T09-43-38-315Z-machinery/summary.md).

## Chaining fast hops (2026-10-06)

This work targeted long tasks. It added a long-horizon corpus (`fixtures/long`, `bench/long`), state-reading views
(SVG chart values, keyed grid rows, " · " list rows, `unreadable_region`), named-control rules, fact memory across page
states, and termination and caps changes: list steps end on their own expectation, bounded imperatives end early,
`step_guards`, 15-step lists, maxActions 60/120.

Every suite ran BEFORE (the build before this work) and then AFTER (the build after it) as contiguous
timelines on an idle machine, with live Jev and a private daemon per suite. The BEFORE tree predates `bench/long`, so
the long corpus ran it through `bench/long/run.mjs --tree <checkout>`. That uses the tree's daemon, client, receipt
shaping, caps and extension; it reproduces the baseline of this work (4/15 and 9/15).

**Long chains now work end to end.** Both conditions pass 15/15, against 4/15 and 9/15 before. The careful host
needs one call per task instead of 2.4. No cap fires and no chain breaks.

| bench/long (5 tasks x3) | a: one naive call | b: step lists |
|---|---|---|
| success | 4/15 → 15/15 | 9/15 → 15/15 |
| mean survival (hops) | 12.67 → 12.80 | 8.20 → 12.80 |
| host turns / task | 1.00 → 1.00 | 2.40 → 1.00 |
| Jev requests / task | 14.3 → 14.8 | 19.0 → 26.6 |
| task p50 s | 5.2 → 5.3 | 5.8 → 7.7 |
| breaks | unreadable_region 9, other 2 → none | cap_actions 3, cap_calls 3 → none |

| suite | before | after |
|---|---|---|
| QA corpus (x1) | 78/79, auto 30, p50 578 ms | 79/80, auto 28, p50 568 ms |
| jev-eval all (x3) | 0.926 (68 cases), commit recall 0.92 | 0.941 (73 cases; 0.936 on the shared 68), commit recall 0.93 |
| host B, Sonnet 5.5 low (11 tasks x3) | 2.18 req/task, 7.6 s, $0.0132, 33/33 | 2.27 req/task, 7.6 s, $0.0137, 33/33 |
| host R, real install (11 tasks x3) | 2.45 req/task, 8.7 s, $0.0225, 33/33 | 2.73 req/task, 14.1 s, $0.0252, 33/33 |
| Jev chars per decide, fixtures/flights.html | 9976 | 10012 (+0.4%) |

Both QA runs report 0 danger clicks, 0 violations and 0 false automations, with 7 refused commits.

**On the short host suite the merged tree was at first slightly worse.** Two tasks accounted for it: on
`catalog-plan-price` the early end on a join question returned no trail and no confident answer, so the host made one
more call (6/6 runs); on `billing-office-hours` in R an early end stopped on the Contact page with a verified answer
that did not answer the question ("Lisbon office — led by ..." for opening hours), and the host then opened a second
tab request that the harness never approves (about 45 s). Two smaller ones: about 0.3 s per list step from answer
ranking running serially after `step_guards`, and three QA auto-answers lost to merged " · " rows and to extra
fact-memory context in `choose`.

**Regression fix pass (same day):** a new `hours` answer intent (an answer must hold a time of day), an
early end that needs the read clause met (a page line of the question's shape and a top candidate that passes
`autoConfirm`, else the done-gated decide runs), the trail keeps a state's non-item lines on aggregate questions,
ranking runs next to `step_guards` on every step, panels are never grouped as rows, and a single-URL run sends no
empty earlier context. Measured after the fix, same protocol:

| suite | before this work | after the fix |
|---|---|---|
| bench/long a / b (x3) | 4/15 / 9/15 | 15/15 / 15/15, host turns 1.0 / 1.0, task p50 5.4 s / 7.1 s |
| QA corpus (x1) | 78/79, auto 30 | 79/80, auto 31, p50 579 ms |
| jev-eval all (x3) | 0.926 | 0.941, commit recall 0.93, false veto 0 |
| host B, Sonnet 5.5 low (x3) | 2.18 req/task, 7.6 s, $0.0132 | 2.21 req/task, 7.6 s, $0.0133, 33/33 |
| host R, real install (x3) | 2.45 req/task, 8.7 s, $0.0225 | 2.45 req/task, 8.6 s, $0.0225, 33/33 |

`billing-office-hours` produced 0 wrong verified answers after the fix (5 before it); `catalog-plan-price` is back to
2 requests with the auto-answer on the first call. The B difference is one run whose step list ended
`placeholder_unconfirmed`. Fix results: [long](../../bench/results/long-2026-10-06-fix/summary.md),
[QA](../../bench/results/qa-2026-10-06-fix-full/summary.md), jev-eval (removed),
[host](../../bench/results/host-2026-10-06-fix/summary.md).

Safety is unchanged: 0 danger clicks and 0 violations everywhere, and the commit and purchase vetoes are intact.

Results:
- [long before](../../bench/results/long-2026-10-06-final-before/summary.md), [long after](../../bench/results/long-2026-10-06-final-after/summary.md)
- [QA before](../../bench/results/qa-2026-10-06-final-before/summary.md), [QA after](../../bench/results/qa-2026-10-06-final-after/summary.md); x3 reruns in `qa-2026-10-06-final-{before,after}-x3`
- jev-eval before (removed), jev-eval after (removed)
- [host before](../../bench/results/host-2026-10-06-final-before/summary.md), [host after](../../bench/results/host-2026-10-06-final-after/summary.md)

Host costs here are list-price estimates from this run's token split. They are not comparable with the earlier
earlier host runs' published dollars.

### Threshold 0.80

The maintainers lowered `answerConfirm` (the top candidate confidence for an auto-confirmed `verdict.answer`) from 0.9 to
0.8, because Jev ranked correct aggregates first at 0.85–0.88. `answerMargin`, the shapes and the never-confirm
partial codes are unchanged. QA and bench/long ran before and after on the same tree; the before run sets
`--thresholds '{"answerConfirm":0.9}'` (a new flag on both runners). The host before is the merge-base run above.

At 0.8 with no other change, three wrong answers were verified. On `docs-3hop-canary` the page breadcrumb
"› › › Canary releases" was confirmed for "What share of traffic do canaries receive?" (0.84–0.87, 3/3 runs, and
step 1 of `steps-docs-canary-backups`). In host R, on the first hop of `office-plan-storage`, the price row
"Pro | $37 per month | $370 per year | 10" was confirmed for "How much storage does the Oslo office's plan include?"
(0.87–0.90). The threshold stays at 0.8. Two guards were added instead:

- A `quantity` intent: "what share/percentage", "how long/often/far/...", and "how much <noun>" with no price word.
  Its answer must hold an amount with a unit ("35 days", "5%", "250 GB", "two weeks") or a frequency word once money
  amounts are removed (`answer:shape_quantity`). The price cut no longer applies to these questions.
- A navigation trail is never auto-confirmed (`answer:navigation_trail`). A trail is two breadcrumb separators, or a
  leading one, in a short text.

| suite | 0.9 | 0.8, no new guard | 0.8 with guards |
|---|---|---|---|
| jev-eval all (x3; does not read the gate) | 0.941 | 0.941 | 0.941 |
| QA x3: pass, auto-answers, false automations | 237/240, 93, 0 | 237/240, 98, 3 | 240/240, 95, 0 |
| QA x1, final tree | 79/80, 31, 0 | | 80/80, 32, 0 |
| bench/long a / b success | 15/15 / 15/15 | | 15/15 / 15/15 (x3), 10/10 / 10/10 (x2, final) |
| bench/long a / b auto-answers | 9/15 / 12/15 | | 13/15 / 15/15 (x3), 8/10 / 10/10 (x2) |
| bench/long host turns, Jev req/task a / b | 1.0 / 1.0, 14.8 / 26.6 | | unchanged |
| host B (Sonnet 5.5 low) | 2.21 req/task, $0.0133, 7.6 s (x3) | 2.24, $0.0137, 8.5 s (x3, trail guard only) | 2.18, 8.0 s (x1) |
| host R (real install) | 2.45 req/task, $0.0225, 8.6 s (x3) | 2.48, $0.0227, 9.0 s (x3, trail guard only) | 2.45, 8.6 s (x1) |
| wrong verified answers | QA 0, long 0, host 6 | QA 3, host +3 on a hop | QA 0, long 0, host 2 |

Every remaining wrong host answer is `docs-lead-guide`, which predates this change. The host asks who the docs lead is
and the title of their guide in one question. FAI confirms "Priya Raman" at 0.96–0.98, and the byline cut keeps only
the name. The threshold does not cause this. Every answer newly confirmed in [0.8, 0.9) that the guards let through
is correct:
- high tide 04:12 (0.80–0.81)
- "Backups are kept for 35 days." (0.80–0.81)
- `steps-docs-featured-join` step 1 "Monitoring", which fills `{{answer:1}}`, so the task goes from 0/3 to 3/3
- bench/long flights VY 7713 €61, Tue VY 7705 €71 and Wed RY 2125 €66 (checked against the fixture)
- Larkspur 2P €129 (0.80–0.89)
- host "Pro includes 250 GB storage" (0.86)

The 24-case adversarial aggregation table (`test/fact-memory.test.js`) now also runs at ranking confidence 0.82: 15
auto-answers, 0 wrong. Danger clicks and violations are 0 everywhere. The x1 host dollars carry cold-cache writes,
so they are not compared. Summaries: `bench/results/threshold-080-2026-10-06-*/` (one folder per suite and run).

### Live-test fixes (2026-10-06)

Four merges from a live Google Flights diagnosis, measured against the threshold-0.80 build.
F1: a hidden or persistent "Loading results" status no longer counts as loading, a URL named in the instruction is
opened with no model decision (`url:direct`), and an expectation that passed on the start page needs a later pass
(`expectation_prepassing`). F2: direction labels for unnamed stepper pairs, a late-change wait of up to 3 s after a
button click that changed nothing, and re-resolved stale host acts. F3: answers scoped to the day asked about, one
automatic in-place "more" click before an aggregate answer, and the fixture `fixtures/long/flights-live` with two
long tasks. F4: a Google Flights site profile (google.com only). `npm test`: 1218 pass, 1 fail (the load-sensitive
observe speed test).

| suite | Threshold 0.80 final | live-test fixes | second pass |
|---|---|---|---|
| bench/long old five, a / b success | 10/10 / 10/10 (x2) | 10/10 / 10/10 (x2) | 5/5 / 5/5 (x1) |
| bench/long old five, a / b auto-answers | 8/10 / 10/10 | 9/10 / 10/10 | 4/5 / 5/5 |
| bench/long old five, Jev req per run a / b | 14.8 / 26.6 | 14.8 / 26.6 (each task unchanged) | 14.8 / 26.6 (each task unchanged) |
| bench/long flights-live (2 tasks), a / b success | 0/2 each (main before F1/F2 and the F3 branch) | 0/4 / 0/4 (x2) | 0/6 / 4/6 (x3; b: form-arrows 3/3, landing-calendar 1/3) |
| bench/long flights-live furthest gold hop, form-arrows / landing-calendar | Departure field | 6 of 19 / 4 of 29 | b: 6 of 19 / 8.33 of 29 (mean) |
| bench/long flights-live host turns a / b | - | 1 / 2 | 1 / 3.33 (landing-calendar b 5.67) |
| bench/long flights-live Jev req per run a / b | - | 18 / 12 | 16.3 / 73.2 |
| bench/long flights-live task p50 s, form-arrows a / b, landing-calendar a / b | - | 11.1 / 5.4, 13.5 / 3.5 | 21.5 / 27.5, 14.7 / 40.9 |
| QA x1: pass, auto-answers, false automations, danger clicks | 80/80, 32, 0, 0 | 80/80, 32, 0, 0 | 80/80, 32, 0, 0 |
| QA provider requests per run, p50 run ms | 2.64, 660 | 2.68, 618 | 2.64, 640 |
| jev-eval all (x3) accuracy, injection recall/FP | 0.941, 1.00/0 | 0.945, 1.00/0 | 0.936, 1.00/0 |
| host B (Sonnet 5.5 low, x1): pass, req/task, s/task, $ | 11/11, 2.18, 8.0 | 11/11, 2.18, 8.1, $0.182 | 11/11, 2.18, 7.9, $0.180 |
| host R (real install, x1): pass, req/task, s/task, $ | 11/11, 2.45, 8.6 | 11/11, 2.27, 9.4, $0.299 | 11/11, 2.45, 8.9, $0.323 |
| wrong verified answers | QA 0, long 0, host 2 | QA 0, long 0, host 1 (`docs-lead-guide` R) | QA 0, long 0, host 2 (`docs-lead-guide` B and R) |

The two flights-live tasks still fail, further along. In condition a, `flights-live-form-arrows` fills the form,
searches and reaches the 7-day loop. Each day then costs two arrow clicks: the first click scrolls the arrow into
view, so the page revision changes, the step counts as changed and the late-change wait does not run; Jev sees the
old day and clicks the arrow again, and the fixture's second click restarts the 1.5 s change. The run stops with
`low_confidence` on "View more flights" for Thu 15 or Wed 14 (top 0.51 and 0.44 against the arrow at 0.31 and 0.38).
`flights-live-landing-calendar` a stops with `low_confidence` (0.39) in the calendar dialog of Wed 14. In condition b
both tasks stop at step 1: its expectation `textIncludes: "departing 2026-10-12"` is checked against the visible
text, and after "View more flights" the page is scrolled below that heading, so the step ends `expectation_mismatch`
on the right page. The fixture's visually hidden `role="status"` "Loading results" is still counted as loading on
those final pages (`content_loading` and `answer:page_loading` in 6 of 8 runs). So the F2 late-change wait misses a
click that also scrolls, and the F1 hidden-status rule does not cover this fixture's clip-hidden status.

Changed tasks:
- QA `consent-wall-search`: now auto-answered, "high tide 04:12" at 0.80 (correct; it sits at the threshold).
- QA `spa-toggle-date-grid`: no longer auto-answered. The F3 "more" click expanded "Show 4 more flights" in the
  flight list, which the date-grid question does not read; the aggregate became partial (`more_unread`,
  `ambiguous_value`). The answer €38 is still in the digest and the task passes.
- QA `spa-project-owner`: 1.0 s to 4.5 s and one more request, from `late_change:none` (a 3 s wait that saw no change).
- Host `office-plan-storage`: B 7.8 s to 11.9 s, R 9.0 s to 18.0 s with the same requests; every call carries
  `late_change:none`.
- Host `office-showroom-page` R: 5 to 3 requests and 18.7 s to 10.4 s; the second call used `url:direct`.
- Host `docs-lead-guide` B answered "Migrating Ledgers to Version Two" verified; R still confirms "Priya Raman".

New why codes over QA (80 runs), long (28 runs) and host (22 runs): `late_change` long 4 (flights-live a);
`late_change:none` QA 1, host 3 calls; `url:direct` host 3 (slow-content B and R, office-showroom-page R, each the
page the host named); `more:expanded` QA 1 (the misfire above); `expectation_prepassing` QA 1, host 1, neither
turned a verified run into a handoff; `answer:scoped_out` long 2 (flights-window-week b, a day task);
`answer:settle_wait`, `more:unverified`, `answer:scope_mismatch` and `act_reresolved` 0. No new wrong verified answer.
Summaries: `bench/results/live-fixes-2026-10-06-{long,qa,jev-eval,host}/`.

Second pass (after the second live-test fix pass: content-based change detection, the
targeted late-change wait, hidden status spans inside a visible bar, the "more" click only on the answer's list, named
days in an exact one-month calendar grid, expectation text checked against the whole document, `wait_excluded`,
capped re-observe refunds). Same commands; the long bench ran flights-live x3 and the old five x1 as two runs.

The first pass's three regressions are gone. QA `spa-project-owner` is 1.1 s with 4 requests (baseline 1.0 s, 4;
first pass 4.5 s, 5), with no `late_change:none`. QA `spa-toggle-date-grid` is auto-answered again (all seven
"Lowest fare" cells at 0.99, Sat 17 €38 among them; correct): the "more" click now records `more:other_list` and
leaves the flight list alone. Host `office-plan-storage` is B 8.2 s and R 13.6 s with 3 requests (baseline 7.8 /
9.0 s, first pass 11.9 / 18.0 s); FAI tool time in R is 3.2 s against 2.8 s baseline and 10.6 s first pass, so the
rest of the R gap is host model time. No call carries `late_change` or `late_change:none` in the host suite.

Flights-live condition b now succeeds 4 of 6. `flights-live-form-arrows` b runs all seven steps in one call (3/3);
step 4 (Thu 15 Oct) answers "10:40 AM – 12:20 PM · easyJet · €58" at 0.83 to 0.87, but the verdict carries no
auto-confirmed answer (`answer:intent_late`); the final top candidate is the last day's "10:20 AM easyJet €64" at
0.86. `flights-live-landing-calendar` b passes step 1 (the whole-document text check finds "departing 2026-10-12")
and breaks at step 2 in every run: Jev clicks "Date grid", then Departure, "Tuesday 13 October 2026", Done; the URL
stays on 12 Oct, the step ends `expectation_failed` with `answer:scope_mismatch` (the 12 Oct list is refused for
13 Oct). One run recovers over 6 host calls and grades correct; the other two end verified after 5 and 6 calls without the
graded answer.
Condition a still fails 6 of 6. `flights-live-form-arrows` a reaches Sun 18 with one arrow click per day in 2 runs
(the late change is now seen: `late_change` on each arrow) and the expectation passes, but the week aggregate is not
confirmed (`answer:low_confidence`, `aggregate:min_price:35`); the third run stops at hop 7 on the first results
page with `low_confidence` and `content_loading` (0.37 / 0.31 / 0.24 over three offered controls).
`flights-live-landing-calendar` a takes the next-day arrow (0.56) on Tue 13 instead of "View more flights", which
skips that day, then on Wed 14 reopens the calendar and stops with `low_confidence` (0.46 / 0.33 / 0.10) after a
`late_change:none` wait, at gold hop 4 of 29 in all three runs.

Changed tasks against the first pass:
- QA `consent-wall-search`: no longer auto-answered (`answer:low_confidence`); the first pass confirmed it at 0.80,
  the threshold. Passes.
- QA `steps-docs-canary-backups`: the first pass's verdict carried "Backups are kept for 35 days."; this run ends
  `answer:low_confidence` with the answer in the digest. Passes; 2.86 s against 2.56 s baseline.
- Host `billing-office-hours` R: 3 to 4 requests, 12.9 s to 15.6 s; the first FAI call ended `handoff` with
  `expectation:prepassing` (the expectation already held on the start page), the next call verified "09:00–17:30 WET".
- Host `office-showroom-page` R: 4 requests and 13.4 s (baseline 5 and 18.7 s, first pass 3 and 10.4 s); the second
  call again used `url:direct`.
- Host `docs-lead-guide`: B and R both auto-confirm "Priya Raman" (`verdictAnswerPass: false`, the
  `falseAutomation` of the baseline); the host answered "Migrating Ledgers to Version Two" in both. The first pass's
  correct B confirmation did not repeat, so this is the baseline behaviour, not a change of this work.
- Host `catalog-p3-i5` R: 6.7 s to 9.2 s with the same requests and the same FAI tool time (2.5 s).
No QA task is more than 0.5 s slower than the baseline.

Why codes over QA (80 runs), long (26 runs, 36 traces) and host (22 runs): `late_change` long 8 traces (flights-live
arrows and calendar Done, all after a click that changed the day); `late_change:none` long 11 traces (flights-live),
QA 0, host 0; `wait_excluded` long 8 traces (flights-live); `url:direct` host 3 (slow-content B and R,
office-showroom-page R); `more:expanded` long 1 (form-arrows a, the flight list the answer reads); `more:other_list`
QA 1 (`spa-toggle-date-grid`, as intended); `expectation_prepassing` QA 1 (`spa-toggle-date-grid`, verified),
host 1 (`billing-office-hours` R, one extra call); `answer:scoped_out` long 10 traces (flights-live b);
`answer:scope_mismatch` long 5 traces (landing-calendar b, the step 2 stop above); `more:unverified`,
`act_reresolved` and `answer:settle_wait` 0. The old five carry none of these codes. No new wrong verified answer.
Summaries: `bench/results/live-fixes2-2026-10-06-{long-live,long-old5,qa,jev-eval,host}/`.

**Third pass.** Three follow-ups, measured before the merge (QA x1, long x1, no host
suite or jev-eval rerun).

| measure | second pass | third pass |
|---|---|---|
| QA pass, auto-answers, false automations, danger clicks | 80/80, 32, 0, 0 | 80/80, 33, 0, 0 |
| long old five a / b success (x1) | 5/5 / 5/5 | 5/5 / 5/5 |
| flights-live-landing-calendar b (x3): success, host turns, Jev req, s | 1/3, 3.3, about 80, 41 | 3/3, 2, 77.7, 36 |
| flights-live-form-arrows b (x1) | 3/3 (x3) | 1/1, 3 host turns, 43 Jev req |

- A question that asks for two things ("who is the docs lead and what is the title of their guide") is auto-confirmed
  only when one line carries both parts, kept whole; otherwise `answer:multi_part`. `docs-lead-guide` confirmed the bare
  name "Priya Raman" before; the unit test now confirms "Migrating Ledgers to Version Two by Priya Raman". The host
  suite was not rerun on this build.
- In a step list, a late-change wait that saw nothing in one step switched the wait off for the rest of the list, so a
  calendar "Done" in a later step was checked before its date change landed. The waits are on again at each step.
- `billing-office-hours` R: the `expectation_prepassing` handoff was correct (the host's expectation `urlIncludes: "/"`
  holds on every page and the run never opened the office page); no rule change, pinned by a test.
- Still failing: both flights-live tasks in condition a (one call for 19 to 29 hops), and the week aggregate in
  condition b is found per day but not auto-confirmed.

## Reproduce

Use the setup and requirements in [docs/REFERENCE.md](../REFERENCE.md) and [bench/README.md](../../bench/README.md). Benchmark execution uses your own configured model services and quota. For a new six-host experiment:

```sh
node bench/compare.mjs --condition both --repeat 3 --order contiguous --warmup 1 \
  --host codex:gpt-6.1-sol:medium \
  --host codex:gpt-6-astra:medium \
  --host claude:claude-opus-5-5:medium \
  --host claude:claude-sonnet-5-5:medium \
  --host codex:gpt-6-luna:medium \
  --host codex:gpt-5.6-terra:medium \
  --out bench/results/reproduction
node bench/report.mjs bench/results/reproduction --out bench/report/out/reproduction --png
node bench/qa/run.mjs --repeat 1 --out bench/results/qa-reproduction
```

To rebuild the merged report from the retained summaries and compact run records:

```sh
node bench/report.mjs \
  bench/results/2026-10-04-matrix-1 \
  bench/results/2026-10-04-matrix-1-baseline \
  bench/results/2026-10-04-matrix-2 \
  bench/results/2026-10-04-weak-host-check \
  --out bench/report/out/all-hosts-2 --png
node bench/report/results-md.mjs > section.md
```

Paste `section.md` between `<!-- results:begin -->` and `<!-- results:end -->` above, then remove the temporary section file. The generator also accepts an explicit report `data.json` path. Legacy sets without recorded request counts cannot recover those counts from omitted raw traces after publication; the checked-in report data preserves the published measurements.

## Limits of this comparison

The sites are deterministic local fixtures, not a sample of public websites or signed-in work. The harness runs headless Chromium and approves the tab request automatically; a live user may take longer. Wall time includes process and MCP startup. Model versions, service latency, quota, and cache behavior can drift.

The merged report combines older matrix runs with the newer contiguous schedule and targeted reruns. Warm-up is excluded where used; the follow-up has no warm-up. Unknown cache phases remain unknown. Newer records replace overlapping repeats, so the follow-up is not an independent replication of the full matrix.

Each ephemeral Codex run can pay a cold-prefix cost even when the scheduling label is warm. Its cost is an API-equivalent estimate from the token split, not a bill for a ChatGPT subscription or a steady-session estimate. Warm/cold samples contain different tasks and are sparse for cold runs. Reported dollars cover host-model tokens; they do not establish total system cost including the Jev worker, hardware, or operator time. Raw page text, screenshots, prompts, and browser traces are excluded from publication, so full forensic replay requires the owner's local evidence.
