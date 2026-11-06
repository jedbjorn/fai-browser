order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 1/1 | 7.7 | 1 | 2 | 2 | 16,130 | 4,854 | 0.0097 | 14,462 | 1,311 | 4 | 353 | 2 |
| about-members | R/claude:claude-sonnet-5-5:low | 1/1 | 5.9 | 1 | 2 | 2 | 38,192 | 6,948 | 0.0139 | 36,560 | 1,294 | 4 | 334 | 2 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 1/1 | 5.8 | 1 | 2 | 2 | 16,103 | 7,149 | 0.0143 | 12,264 | 3,535 | 4 | 300 | 1 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 1/1 | 7.0 | 1 | 2 | 2 | 38,088 | 12,080 | 0.0242 | 31,759 | 6,060 | 4 | 265 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 1/1 | 8.9 | 1 | 2 | 2 | 16,440 | 7,781 | 0.0156 | 12,283 | 3,791 | 4 | 362 | 3 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 1/1 | 6.5 | 1 | 2 | 2 | 38,445 | 12,711 | 0.0254 | 31,778 | 6,343 | 4 | 320 | 3 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 1/1 | 9.8 | 1 | 2 | 2 | 16,717 | 8,120 | 0.0162 | 12,270 | 4,087 | 4 | 356 | 4 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 1/1 | 6.7 | 1 | 2 | 2 | 38,598 | 12,797 | 0.0256 | 31,765 | 6,541 | 4 | 288 | 4 |
| slow-content | B/claude:claude-sonnet-5-5:low | 1/1 | 7.7 | 1 | 2 | 2 | 16,119 | 7,430 | 0.0149 | 12,295 | 3,441 | 4 | 379 | 3 |
| slow-content | R/claude:claude-sonnet-5-5:low | 1/1 | 8.2 | 1 | 2 | 2 | 38,187 | 12,584 | 0.0252 | 31,790 | 6,017 | 4 | 376 | 3 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 1/1 | 7.6 | 1 | 2 | 2 | 15,943 | 6,950 | 0.0139 | 12,280 | 3,354 | 4 | 305 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 1/1 | 6.1 | 1 | 2 | 2 | 37,998 | 12,017 | 0.0240 | 31,775 | 5,936 | 4 | 283 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 1/1 | 7.9 | 1 | 2 | 2 | 16,344 | 7,609 | 0.0152 | 12,289 | 3,701 | 4 | 350 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 1/1 | 6.1 | 1 | 2 | 2 | 38,392 | 12,679 | 0.0254 | 31,784 | 6,273 | 4 | 331 | 3 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 1/1 | 6.7 | 1 | 2 | 2 | 16,591 | 8,020 | 0.0160 | 12,295 | 3,913 | 4 | 379 | 4 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 1/1 | 6.8 | 1 | 2 | 2 | 38,646 | 13,109 | 0.0262 | 31,790 | 6,489 | 4 | 363 | 4 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 1/1 | 9.0 | 2 | 3 | 3 | 27,528 | 11,850 | 0.0237 | 21,498 | 5,447 | 6 | 577 | 4 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 1/1 | 13.6 | 2 | 3 | 3 | 60,745 | 18,853 | 0.0377 | 51,954 | 8,073 | 6 | 712 | 10 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 1/1 | 7.8 | 1 | 2 | 2 | 17,205 | 8,718 | 0.0174 | 12,456 | 4,335 | 4 | 410 | 6 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 1/1 | 9.0 | 2 | 3 | 3 | 60,033 | 17,820 | 0.0356 | 51,732 | 7,689 | 6 | 606 | 7 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 1/1 | 9.5 | 2 | 3 | 3 | 26,692 | 11,136 | 0.0223 | 21,086 | 5,061 | 6 | 539 | 6 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 1/1 | 18.7 | 4 | 5 | 5 | 107,470 | 28,376 | 0.0568 | 95,830 | 10,498 | 10 | 1,132 | 8 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 11/11 | 88.5 | 13 | 24 | 24 | 201,812 | 89,616 | 0.179 | 155,478 | 41,976 | 48 | 4,310 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 11/11 | 94.7 | 16 | 27 | 27 | 534,794 | 159,972 | 0.320 | 458,517 | 71,213 | 54 | 5,010 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 11/11 | 88.5 | 13 | 24 | 24 | 89,616 | 0.179 | list | 0.179 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 11/11 | 94.7 | 16 | 27 | 27 | 159,972 | 0.320 | list | 0.320 |

B/claude:claude-sonnet-5-5:low receipts: 13; oversight rate 46% (6 with verdict.oversight other than none); auto-confirmed answers 7, false automation 1.

R/claude:claude-sonnet-5-5:low receipts: 16; oversight rate 63% (10 with verdict.oversight other than none); auto-confirmed answers 6, false automation 1.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 13, of which with steps: 3.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 16, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 11 | 4 / 4 | 79 | 3,816 | 0.0163 | 0.0163 (11) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 11 | 5 / 4 | 87 | 6,474 | 0.0291 | 0.0291 (11) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0146; R FAI Browser (real install) 4 uncached, $0.0247.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.07x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.65x, priced 1.79x, cost 1.79x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.07x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.65x, priced 1.79x, cost 1.79x.

Warm-up runs (excluded): 2, cost $0.0822 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 11 R run(s): 0 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

