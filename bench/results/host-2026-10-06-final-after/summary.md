order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 3/3 | 5.9 | 1 | 2 | 2 | 16,096 | 4,661 | 0.0093 | 14,462 | 1,309 | 4 | 315 | 1 |
| about-members | R/claude:claude-sonnet-5-5:low | 3/3 | 6.0 | 1 | 2 | 2 | 38,146 | 6,733 | 0.0135 | 36,560 | 1,283 | 4 | 292 | 1 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 3/3 | 6.5 | 1 | 2 | 2 | 16,092 | 4,656 | 0.0093 | 14,440 | 1,358 | 4 | 305 | 1 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 3/3 | 5.9 | 1 | 2 | 2 | 38,093 | 6,593 | 0.0132 | 36,538 | 1,292 | 4 | 265 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 3/3 | 7.6 | 1 | 2 | 2 | 16,421 | 5,222 | 0.0104 | 14,478 | 1,585 | 4 | 359 | 3 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 3/3 | 6.9 | 1 | 2 | 2 | 38,463 | 7,283 | 0.0146 | 36,576 | 1,558 | 4 | 325 | 3 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 3/3 | 6.3 | 1 | 2 | 2 | 16,539 | 5,290 | 0.0106 | 14,452 | 1,769 | 4 | 315 | 3 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 3/3 | 6.4 | 1 | 2 | 2 | 38,598 | 7,594 | 0.0152 | 36,550 | 1,754 | 4 | 290 | 3 |
| slow-content | B/claude:claude-sonnet-5-5:low | 3/3 | 7.9 | 1 | 2 | 2 | 16,125 | 4,905 | 0.0098 | 14,502 | 1,245 | 4 | 376 | 3 |
| slow-content | R/claude:claude-sonnet-5-5:low | 3/3 | 6.6 | 1 | 2 | 2 | 38,174 | 6,980 | 0.0140 | 36,600 | 1,209 | 4 | 361 | 3 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 3/3 | 5.8 | 1 | 2 | 2 | 15,959 | 4,464 | 0.0089 | 14,472 | 1,182 | 4 | 308 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 3/3 | 6.1 | 1 | 2 | 2 | 38,004 | 6,514 | 0.0130 | 36,570 | 1,147 | 4 | 284 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 3/3 | 6.1 | 1 | 2 | 2 | 16,337 | 5,077 | 0.0102 | 14,490 | 1,491 | 4 | 352 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 3/3 | 7.0 | 1 | 2 | 2 | 38,530 | 7,444 | 0.0149 | 36,588 | 1,677 | 4 | 330 | 5 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 3/3 | 10.3 | 2 | 3 | 3 | 26,723 | 9,247 | 0.0185 | 23,128 | 2,988 | 6 | 638 | 7 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 3/3 | 10.9 | 2 | 3 | 3 | 59,863 | 12,697 | 0.0254 | 56,248 | 2,986 | 6 | 639 | 6 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 3/3 | 8.9 | 2 | 3 | 3 | 27,534 | 9,509 | 0.0190 | 23,835 | 3,177 | 6 | 585 | 4 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 3/3 | 66.7 | 4 | 5 | 5 | 107,101 | 22,868 | 0.0457 | 100,567 | 5,364 | 10 | 1,223 | 13 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 3/3 | 7.6 | 1 | 2 | 2 | 17,123 | 5,896 | 0.0118 | 14,824 | 1,884 | 4 | 411 | 6 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 3/3 | 10.2 | 2 | 3 | 3 | 60,006 | 12,308 | 0.0246 | 56,532 | 2,821 | 6 | 624 | 7 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 3/3 | 8.9 | 2 | 3 | 3 | 26,616 | 8,195 | 0.0164 | 23,436 | 2,672 | 6 | 501 | 5 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 3/3 | 16.6 | 4 | 5 | 5 | 111,017 | 25,663 | 0.0513 | 102,996 | 8,168 | 10 | 1,424 | 7 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 33/33 | 81.9 | 14 | 25 | 25 | 211,565 | 67,123 | 0.134 | 186,519 | 20,660 | 50 | 4,465 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 33/33 | 149.2 | 19 | 30 | 30 | 605,995 | 122,676 | 0.245 | 572,325 | 29,259 | 60 | 6,057 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 81.9 | 14 | 25 | 25 | 67,123 | 0.134 | list | 0.134 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 149.2 | 19 | 30 | 30 | 122,676 | 0.245 | list | 0.245 |

B/claude:claude-sonnet-5-5:low receipts: 42; oversight rate 67% (28 with verdict.oversight other than none); auto-confirmed answers 15, false automation 2.

R/claude:claude-sonnet-5-5:low receipts: 53; oversight rate 60% (32 with verdict.oversight other than none); auto-confirmed answers 21 (6 on intermediate hops), false automation 2.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 42, of which with steps: 10.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 55, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 33 | 5 / 4 | 86 | 2,548 | 0.0137 | 0.0137 (33) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 33 | 5 / 4 | 93 | 3,902 | 0.0252 | 0.0252 (33) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0098; R FAI Browser (real install) 4 uncached, $0.0141.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.82x, tool calls 1.36x, requests 1.20x (adjusted 1.20x), tokens 2.86x, priced 1.83x, cost 1.83x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.82x, tool calls 1.36x, requests 1.20x (adjusted 1.20x), tokens 2.86x, priced 1.83x, cost 1.83x.

Warm-up runs (excluded): 2, cost $0.0823 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 33 R run(s): 2 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

