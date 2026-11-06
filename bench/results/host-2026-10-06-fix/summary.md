order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 3/3 | 6.1 | 1 | 2 | 2 | 16,133 | 4,858 | 0.0097 | 14,462 | 1,314 | 4 | 353 | 2 |
| about-members | R/claude:claude-sonnet-5-5:low | 3/3 | 6.5 | 1 | 2 | 2 | 38,133 | 6,701 | 0.0134 | 36,560 | 1,281 | 4 | 288 | 2 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 3/3 | 5.5 | 1 | 2 | 2 | 16,069 | 4,612 | 0.0092 | 14,440 | 1,327 | 4 | 296 | 1 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 3/3 | 6.4 | 1 | 2 | 2 | 38,103 | 6,622 | 0.0132 | 36,538 | 1,291 | 4 | 265 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 3/3 | 6.8 | 1 | 2 | 2 | 16,417 | 5,216 | 0.0104 | 14,478 | 1,586 | 4 | 356 | 3 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 3/3 | 7.9 | 1 | 2 | 2 | 38,460 | 7,212 | 0.0144 | 36,576 | 1,560 | 4 | 320 | 3 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 3/3 | 7.2 | 1 | 2 | 2 | 16,548 | 5,285 | 0.0106 | 14,452 | 1,801 | 4 | 316 | 4 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 3/3 | 6.7 | 1 | 2 | 2 | 38,591 | 7,294 | 0.0146 | 36,550 | 1,752 | 4 | 290 | 4 |
| slow-content | B/claude:claude-sonnet-5-5:low | 3/3 | 7.4 | 1 | 2 | 2 | 16,148 | 5,004 | 0.0100 | 14,502 | 1,268 | 4 | 393 | 2 |
| slow-content | R/claude:claude-sonnet-5-5:low | 3/3 | 7.1 | 1 | 2 | 2 | 38,152 | 7,020 | 0.0140 | 36,600 | 1,209 | 4 | 354 | 3 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 3/3 | 5.5 | 1 | 2 | 2 | 15,949 | 4,446 | 0.0089 | 14,472 | 1,172 | 4 | 306 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 3/3 | 6.2 | 1 | 2 | 2 | 37,992 | 6,490 | 0.0130 | 36,570 | 1,143 | 4 | 280 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 3/3 | 6.4 | 1 | 2 | 2 | 16,351 | 5,148 | 0.0103 | 14,490 | 1,500 | 4 | 356 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 3/3 | 7.0 | 1 | 2 | 2 | 38,527 | 7,448 | 0.0149 | 36,588 | 1,624 | 4 | 351 | 5 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 3/3 | 7.5 | 1 | 2 | 2 | 16,602 | 5,518 | 0.0110 | 14,502 | 1,711 | 4 | 385 | 4 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 3/3 | 6.7 | 1 | 2 | 2 | 38,667 | 7,649 | 0.0153 | 36,600 | 1,695 | 4 | 368 | 4 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 3/3 | 9.4 | 2 | 3 | 3 | 27,525 | 9,194 | 0.0184 | 23,832 | 3,113 | 6 | 586 | 4 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 3/3 | 16.7 | 3 | 4 | 4 | 83,439 | 17,647 | 0.0353 | 73,362 | 4,416 | 8 | 860 | 16 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 3/3 | 9.7 | 1 | 2 | 2 | 17,134 | 8,640 | 0.0173 | 14,824 | 3,339 | 4 | 418 | 6 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 3/3 | 10.1 | 2 | 3 | 3 | 60,060 | 12,293 | 0.0246 | 56,560 | 2,854 | 6 | 619 | 7 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 3/3 | 9.6 | 2 | 3 | 3 | 26,680 | 8,367 | 0.0167 | 23,451 | 2,699 | 6 | 529 | 6 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 3/3 | 17.4 | 4 | 5 | 5 | 108,275 | 24,545 | 0.0491 | 96,147 | 5,930 | 10 | 1,406 | 8 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 33/33 | 81.2 | 13 | 24 | 24 | 201,556 | 66,288 | 0.133 | 177,905 | 20,830 | 48 | 4,294 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 33/33 | 98.7 | 17 | 28 | 28 | 558,399 | 110,921 | 0.222 | 518,651 | 24,755 | 56 | 5,401 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 81.2 | 13 | 24 | 24 | 66,288 | 0.133 | list | 0.133 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 98.7 | 17 | 28 | 28 | 110,921 | 0.222 | list | 0.222 |

B/claude:claude-sonnet-5-5:low receipts: 40; oversight rate 55% (22 with verdict.oversight other than none); auto-confirmed answers 18, false automation 3.

R/claude:claude-sonnet-5-5:low receipts: 48; oversight rate 60% (29 with verdict.oversight other than none); auto-confirmed answers 19 (1 on intermediate hops), false automation 3.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 40, of which with steps: 10.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 48, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 33 | 4 / 4 | 86 | 2,482 | 0.0133 | 0.0133 (33) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 33 | 5 / 4 | 93 | 3,575 | 0.0225 | 0.0225 (33) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0100; R FAI Browser (real install) 4 uncached, $0.0140.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.22x, tool calls 1.31x, requests 1.17x (adjusted 1.17x), tokens 2.77x, priced 1.67x, cost 1.67x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.22x, tool calls 1.31x, requests 1.17x (adjusted 1.17x), tokens 2.77x, priced 1.67x, cost 1.67x.

Warm-up runs (excluded): 2, cost $0.0820 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 33 R run(s): 1 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

