order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 3/3 | 6.6 | 1 | 2 | 2 | 16,079 | 4,715 | 0.0094 | 14,426 | 1,300 | 4 | 322 | 2 |
| about-members | R/claude:claude-sonnet-5-5:low | 3/3 | 6.7 | 1 | 2 | 2 | 38,136 | 6,911 | 0.0138 | 36,524 | 1,276 | 4 | 332 | 2 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 3/3 | 5.9 | 1 | 2 | 2 | 16,015 | 4,586 | 0.0092 | 14,404 | 1,321 | 4 | 294 | 2 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 3/3 | 5.9 | 1 | 2 | 2 | 38,052 | 6,610 | 0.0132 | 36,502 | 1,285 | 4 | 264 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 3/3 | 6.6 | 1 | 2 | 2 | 16,369 | 5,206 | 0.0104 | 14,442 | 1,570 | 4 | 357 | 4 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 3/3 | 6.4 | 1 | 2 | 2 | 38,433 | 7,314 | 0.0146 | 36,540 | 1,551 | 4 | 338 | 4 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 3/3 | 6.2 | 1 | 2 | 2 | 16,430 | 5,162 | 0.0103 | 14,416 | 1,694 | 4 | 315 | 4 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 3/3 | 6.4 | 1 | 2 | 2 | 38,484 | 7,200 | 0.0144 | 36,514 | 1,676 | 4 | 290 | 4 |
| slow-content | B/claude:claude-sonnet-5-5:low | 3/3 | 6.8 | 1 | 2 | 2 | 16,041 | 4,862 | 0.0097 | 14,466 | 1,194 | 4 | 386 | 3 |
| slow-content | R/claude:claude-sonnet-5-5:low | 3/3 | 6.8 | 1 | 2 | 2 | 38,072 | 6,872 | 0.0137 | 36,564 | 1,151 | 4 | 353 | 3 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 3/3 | 6.2 | 1 | 2 | 2 | 15,907 | 4,434 | 0.0089 | 14,436 | 1,162 | 4 | 305 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 3/3 | 5.5 | 1 | 2 | 2 | 37,960 | 6,485 | 0.0130 | 36,534 | 1,142 | 4 | 280 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 3/3 | 6.8 | 1 | 2 | 2 | 16,294 | 5,514 | 0.0110 | 14,454 | 1,632 | 4 | 358 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 3/3 | 7.1 | 1 | 2 | 2 | 38,511 | 7,452 | 0.0149 | 36,552 | 1,602 | 4 | 356 | 5 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 3/3 | 6.8 | 1 | 2 | 2 | 16,534 | 5,644 | 0.0113 | 14,466 | 1,715 | 4 | 393 | 4 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 3/3 | 7.5 | 1 | 2 | 2 | 38,604 | 7,608 | 0.0152 | 36,564 | 1,662 | 4 | 374 | 4 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 3/3 | 9.1 | 2 | 3 | 3 | 27,430 | 9,438 | 0.0189 | 23,778 | 3,059 | 6 | 587 | 5 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 3/3 | 12.9 | 2 | 3 | 3 | 60,623 | 12,838 | 0.0257 | 56,825 | 3,160 | 6 | 640 | 12 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 3/3 | 7.7 | 1 | 2 | 2 | 17,073 | 5,887 | 0.0118 | 14,788 | 1,867 | 4 | 414 | 7 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 3/3 | 10.8 | 2 | 3 | 3 | 60,009 | 12,785 | 0.0256 | 56,475 | 2,857 | 6 | 650 | 7 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 3/3 | 11.1 | 2 | 3 | 3 | 27,574 | 9,092 | 0.0182 | 23,870 | 3,150 | 6 | 551 | 7 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 3/3 | 16.3 | 4 | 5 | 5 | 107,810 | 24,306 | 0.0486 | 95,952 | 5,758 | 10 | 1,349 | 10 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 33/33 | 79.7 | 13 | 24 | 24 | 201,746 | 64,540 | 0.129 | 177,946 | 19,664 | 48 | 4,282 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 33/33 | 92.2 | 16 | 27 | 27 | 534,694 | 106,381 | 0.213 | 501,546 | 23,120 | 54 | 5,226 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 79.7 | 13 | 24 | 24 | 64,540 | 0.129 | list | 0.129 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 92.2 | 16 | 27 | 27 | 106,381 | 0.213 | list | 0.213 |

B/claude:claude-sonnet-5-5:low receipts: 39; oversight rate 59% (23 with verdict.oversight other than none); auto-confirmed answers 17, false automation 2.

R/claude:claude-sonnet-5-5:low receipts: 48; oversight rate 63% (30 with verdict.oversight other than none); auto-confirmed answers 18 (3 on intermediate hops), false automation 3.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 39, of which with steps: 16.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 48, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 33 | 4 / 4 | 86 | 2,447 | 0.0132 | 0.0132 (33) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 33 | 5 / 4 | 93 | 3,560 | 0.0225 | 0.0225 (33) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0097; R FAI Browser (real install) 4 uncached, $0.0139.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.16x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.65x, priced 1.65x, cost 1.65x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.16x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.65x, priced 1.65x, cost 1.65x.

Warm-up runs (excluded): 2, cost $0.0820 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 33 R run(s): 1 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

