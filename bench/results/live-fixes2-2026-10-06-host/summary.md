order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 1/1 | 6.2 | 1 | 2 | 2 | 16,105 | 4,651 | 0.0093 | 14,474 | 1,316 | 4 | 311 | 2 |
| about-members | R/claude:claude-sonnet-5-5:low | 1/1 | 6.0 | 1 | 2 | 2 | 38,197 | 6,940 | 0.0139 | 36,572 | 1,287 | 4 | 334 | 2 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 1/1 | 5.6 | 1 | 2 | 2 | 16,082 | 7,154 | 0.0143 | 12,276 | 3,490 | 4 | 312 | 1 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 1/1 | 5.6 | 1 | 2 | 2 | 38,099 | 12,069 | 0.0241 | 31,771 | 6,062 | 4 | 262 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 1/1 | 8.2 | 1 | 2 | 2 | 16,430 | 7,717 | 0.0154 | 12,295 | 3,779 | 4 | 352 | 3 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 1/1 | 8.1 | 1 | 2 | 2 | 38,448 | 12,659 | 0.0253 | 31,790 | 6,345 | 4 | 309 | 3 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 1/1 | 8.9 | 1 | 2 | 2 | 16,558 | 7,772 | 0.0155 | 12,282 | 3,952 | 4 | 320 | 4 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 1/1 | 9.2 | 1 | 2 | 2 | 38,609 | 12,827 | 0.0257 | 31,777 | 6,532 | 4 | 296 | 4 |
| slow-content | B/claude:claude-sonnet-5-5:low | 1/1 | 6.2 | 1 | 2 | 2 | 16,088 | 7,497 | 0.0150 | 12,307 | 3,366 | 4 | 411 | 0 |
| slow-content | R/claude:claude-sonnet-5-5:low | 1/1 | 8.5 | 1 | 2 | 2 | 38,129 | 12,535 | 0.0251 | 31,802 | 5,937 | 4 | 386 | 0 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 1/1 | 7.4 | 1 | 2 | 2 | 15,960 | 6,961 | 0.0139 | 12,292 | 3,358 | 4 | 306 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 1/1 | 5.7 | 1 | 2 | 2 | 38,013 | 12,025 | 0.0241 | 31,787 | 5,938 | 4 | 284 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 1/1 | 7.2 | 1 | 2 | 2 | 16,384 | 7,709 | 0.0154 | 12,301 | 3,712 | 4 | 367 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 1/1 | 5.9 | 1 | 2 | 2 | 38,415 | 12,705 | 0.0254 | 31,796 | 6,281 | 4 | 334 | 3 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 1/1 | 7.7 | 1 | 2 | 2 | 16,588 | 8,006 | 0.0160 | 12,307 | 3,897 | 4 | 380 | 4 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 1/1 | 6.5 | 1 | 2 | 2 | 38,617 | 13,014 | 0.0260 | 31,802 | 6,460 | 4 | 351 | 4 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 1/1 | 10.5 | 2 | 3 | 3 | 27,473 | 11,707 | 0.0234 | 21,494 | 5,417 | 6 | 556 | 4 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 1/1 | 15.6 | 3 | 4 | 4 | 82,263 | 22,557 | 0.0451 | 72,575 | 8,829 | 8 | 851 | 8 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 1/1 | 8.2 | 1 | 2 | 2 | 17,225 | 8,741 | 0.0175 | 12,468 | 4,340 | 4 | 413 | 6 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 1/1 | 13.6 | 2 | 3 | 3 | 60,163 | 18,186 | 0.0364 | 51,738 | 7,757 | 6 | 662 | 7 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 1/1 | 11.0 | 2 | 3 | 3 | 27,830 | 12,173 | 0.0243 | 21,633 | 5,587 | 6 | 604 | 5 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 1/1 | 13.4 | 3 | 4 | 4 | 85,716 | 25,974 | 0.0519 | 74,482 | 10,030 | 8 | 1,196 | 6 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 11/11 | 87.2 | 13 | 24 | 24 | 202,723 | 90,088 | 0.180 | 156,129 | 42,214 | 48 | 4,332 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 11/11 | 98.1 | 16 | 27 | 27 | 534,669 | 161,491 | 0.323 | 457,892 | 71,458 | 54 | 5,265 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 11/11 | 87.2 | 13 | 24 | 24 | 90,088 | 0.180 | list | 0.180 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 11/11 | 98.1 | 16 | 27 | 27 | 161,491 | 0.323 | list | 0.323 |

B/claude:claude-sonnet-5-5:low receipts: 13; oversight rate 46% (6 with verdict.oversight other than none); auto-confirmed answers 7, false automation 1.

R/claude:claude-sonnet-5-5:low receipts: 16; oversight rate 56% (9 with verdict.oversight other than none); auto-confirmed answers 7, false automation 1.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 13, of which with steps: 4.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 16, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 11 | 4 / 4 | 79 | 3,838 | 0.0164 | 0.0164 (11) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 11 | 5 / 4 | 86 | 6,496 | 0.0294 | 0.0294 (11) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0147; R FAI Browser (real install) 4 uncached, $0.0246.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.12x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.64x, priced 1.79x, cost 1.79x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.12x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.64x, priced 1.79x, cost 1.79x.

Warm-up runs (excluded): 2, cost $0.0818 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 11 R run(s): 1 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

