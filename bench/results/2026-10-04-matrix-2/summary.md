order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | A/claude:claude-sonnet-5-5:medium | 3/3 | 6.6 | 4 | 4 | 4 | 40,583 | 7,907 | 0.0158 | 38,324 | 1,917 | 8 | 316 | - |
| about-members | B/claude:claude-sonnet-5-5:medium | 3/3 | 7.0 | 1 | 2 | 2 | 13,757 | 4,622 | 0.0092 | 12,114 | 1,277 | 4 | 362 | 2 |
| about-members | A/codex:gpt-6-luna:medium | 3/3 | 19.9 | 4 | 5 | 6 | 62,867 | 14,751 | 0.0015 | 55,808 | - | 8,275 | 222 | - |
| about-members | B/codex:gpt-6-luna:medium | 3/3 | 13.4 | 1 | 2 | 3 | 45,809 | 17,817 | 0.0018 | 30,720 | - | 13,425 | 264 | 2 |
| about-members | A/codex:gpt-5.6-terra:medium | 3/3 | 18.6 | 5 | 6 | 7 | 73,746 | 20,544 | 0.0418 | 63,488 | - | 13,524 | 334 | - |
| about-members | B/codex:gpt-5.6-terra:medium | 3/3 | 12.0 | 1 | 2 | 3 | 33,292 | 11,793 | 0.0240 | 26,880 | - | 7,726 | 255 | 2 |
| pricing-pro | A/claude:claude-sonnet-5-5:medium | 3/3 | 6.7 | 4 | 4 | 4 | 41,125 | 9,035 | 0.0181 | 38,299 | 2,690 | 8 | 291 | - |
| pricing-pro | B/claude:claude-sonnet-5-5:medium | 3/3 | 6.4 | 1 | 2 | 2 | 13,656 | 4,334 | 0.0087 | 12,092 | 1,257 | 4 | 310 | 2 |
| pricing-pro | A/codex:gpt-6-luna:medium | 3/3 | 16.1 | 4 | 5 | 6 | 63,043 | 19,197 | 0.0019 | 49,664 | - | 13,186 | 208 | - |
| pricing-pro | B/codex:gpt-6-luna:medium | 3/3 | 15.7 | 1 | 2 | 3 | 45,703 | 18,009 | 0.0018 | 31,744 | - | 13,728 | 224 | 2 |
| pricing-pro | A/codex:gpt-5.6-terra:medium | 3/3 | 15.1 | 4 | 5 | 6 | 75,624 | 18,047 | 0.0367 | 58,112 | - | 11,963 | 285 | - |
| pricing-pro | B/codex:gpt-5.6-terra:medium | 1/3 | 13.0 | 1 | 2 | 3 | 37,373 | 9,846 | 0.0204 | 33,792 | - | 5,419 | 586 | 2 |
| docs-auth-header | A/claude:claude-sonnet-5-5:medium | 3/3 | 10.0 | 8 | 8 | 8 | 89,825 | 16,673 | 0.0333 | 84,945 | 4,310 | 16 | 555 | - |
| docs-auth-header | B/claude:claude-sonnet-5-5:medium | 3/3 | 7.3 | 1 | 2 | 2 | 13,860 | 4,668 | 0.0093 | 12,130 | 1,381 | 4 | 348 | 4 |
| docs-auth-header | A/codex:gpt-6-luna:medium | 3/3 | 26.9 | 10 | 11 | 12 | 136,736 | 27,913 | 0.0028 | 115,712 | - | 16,328 | 435 | - |
| docs-auth-header | B/codex:gpt-6-luna:medium | 3/3 | 15.2 | 1 | 2 | 3 | 46,048 | 18,886 | 0.0019 | 31,744 | - | 14,152 | 244 | 4 |
| docs-auth-header | A/codex:gpt-5.6-terra:medium | 3/3 | 29.8 | 8 | 9 | 10 | 124,542 | 26,244 | 0.0536 | 111,616 | - | 12,387 | 496 | - |
| docs-auth-header | B/codex:gpt-5.6-terra:medium | 2/3 | 17.4 | 1 | 2 | 3 | 44,086 | 13,268 | 0.0275 | 35,840 | - | 6,263 | 481 | 4 |
| catalog-p3-i5 | A/claude:claude-sonnet-5-5:medium | 3/3 | 6.6 | 4 | 5 | 5 | 51,891 | 9,544 | 0.0191 | 49,103 | 2,471 | 10 | 304 | - |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:medium | 3/3 | 7.5 | 1 | 2 | 2 | 14,104 | 4,966 | 0.0099 | 12,104 | 1,661 | 4 | 335 | 4 |
| catalog-p3-i5 | A/codex:gpt-6-luna:medium | 3/3 | 19.6 | 6 | 7 | 8 | 87,889 | 19,915 | 0.0020 | 76,800 | - | 10,805 | 285 | - |
| catalog-p3-i5 | B/codex:gpt-6-luna:medium | 3/3 | 14.7 | 1 | 2 | 3 | 46,339 | 18,920 | 0.0019 | 31,744 | - | 14,291 | 292 | 4 |
| catalog-p3-i5 | A/codex:gpt-5.6-terra:medium | 3/3 | 27.2 | 8 | 9 | 10 | 137,711 | 27,772 | 0.0565 | 124,416 | - | 12,835 | 499 | - |
| catalog-p3-i5 | B/codex:gpt-5.6-terra:medium | 3/3 | 16.0 | 1 | 2 | 3 | 44,468 | 13,876 | 0.0286 | 26,880 | - | 8,242 | 401 | 4 |
| slow-content | A/claude:claude-sonnet-5-5:medium | 3/3 | 8.7 | 3 | 4 | 4 | 39,389 | 6,307 | 0.0126 | 37,223 | 1,110 | 8 | 223 | - |
| slow-content | B/claude:claude-sonnet-5-5:medium | 3/3 | 8.0 | 1 | 2 | 2 | 13,624 | 4,522 | 0.0090 | 12,154 | 1,080 | 4 | 391 | 2 |
| slow-content | A/codex:gpt-6-luna:medium | 3/3 | 13.4 | 3 | 4 | 5 | 49,582 | 10,062 | 0.0010 | 42,752 | - | 4,602 | 180 | - |
| slow-content | B/codex:gpt-6-luna:medium | 3/3 | 13.4 | 1 | 2 | 3 | 45,506 | 15,543 | 0.0016 | 29,952 | - | 12,392 | 229 | 2 |
| slow-content | A/codex:gpt-5.6-terra:medium | 3/3 | 16.6 | 3 | 4 | 5 | 59,561 | 13,742 | 0.0280 | 51,968 | - | 7,355 | 224 | - |
| slow-content | B/codex:gpt-5.6-terra:medium | 2/3 | 14.8 | 1 | 2 | 3 | 33,060 | 11,347 | 0.0233 | 24,832 | - | 6,213 | 310 | 2 |
| settings-new-tab | A/claude:claude-sonnet-5-5:medium | 3/3 | 10.9 | 6 | 7 | 7 | 73,066 | 12,135 | 0.0243 | 70,198 | 2,445 | 14 | 409 | - |
| settings-new-tab | B/claude:claude-sonnet-5-5:medium | 3/3 | 6.1 | 1 | 2 | 2 | 13,552 | 4,211 | 0.0084 | 12,124 | 1,116 | 4 | 316 | 2 |
| settings-new-tab | A/codex:gpt-6-luna:medium | 3/3 | 15.2 | 5 | 6 | 7 | 78,117 | 23,372 | 0.0023 | 61,952 | - | 15,912 | 252 | - |
| settings-new-tab | B/codex:gpt-6-luna:medium | 3/3 | 14.2 | 1 | 2 | 3 | 45,582 | 11,541 | 0.0012 | 38,912 | - | 6,425 | 245 | 2 |
| settings-new-tab | A/codex:gpt-5.6-terra:medium | 3/3 | 16.2 | 5 | 6 | 7 | 73,854 | 18,279 | 0.0372 | 65,024 | - | 8,851 | 324 | - |
| settings-new-tab | B/codex:gpt-5.6-terra:medium | 3/3 | 12.8 | 1 | 2 | 3 | 43,611 | 12,515 | 0.0256 | 35,840 | - | 7,481 | 290 | 2 |
| docs-lead-guide | A/claude:claude-sonnet-5-5:medium | 3/3 | 7.8 | 4 | 4 | 4 | 40,980 | 8,013 | 0.0160 | 38,554 | 2,140 | 8 | 295 | - |
| docs-lead-guide | B/claude:claude-sonnet-5-5:medium | 3/3 | 6.7 | 1 | 2 | 2 | 13,907 | 4,818 | 0.0096 | 12,142 | 1,388 | 4 | 373 | 3 |
| docs-lead-guide | A/codex:gpt-6-luna:medium | 3/3 | 21.5 | 6 | 7 | 8 | 86,963 | 18,863 | 0.0019 | 76,800 | - | 9,848 | 273 | - |
| docs-lead-guide | B/codex:gpt-6-luna:medium | 0/3 | 15.9 | 1 | 2 | 3 | 45,529 | 12,235 | 0.0012 | 38,912 | - | 6,834 | 302 | 3 |
| docs-lead-guide | A/codex:gpt-5.6-terra:medium | 3/3 | 25.9 | 6 | 7 | 8 | 102,237 | 21,743 | 0.0442 | 91,136 | - | 10,719 | 390 | - |
| docs-lead-guide | B/codex:gpt-5.6-terra:medium | 0/3 | 21.8 | 1 | 2 | 3 | 44,426 | 13,156 | 0.0273 | 36,864 | - | 8,311 | 477 | 3 |
| catalog-plan-price | A/claude:claude-sonnet-5-5:medium | 3/3 | 13.2 | 8 | 7 | 7 | 78,036 | 15,664 | 0.0313 | 73,470 | 4,059 | 14 | 600 | - |
| catalog-plan-price | B/claude:claude-sonnet-5-5:medium | 3/3 | 7.8 | 1 | 2 | 2 | 14,206 | 5,287 | 0.0106 | 12,154 | 1,651 | 4 | 399 | 4 |
| catalog-plan-price | A/codex:gpt-6-luna:medium | 2/3 | 21.0 | 9 | 10 | 11 | 101,593 | 22,199 | 0.0022 | 89,856 | - | 11,368 | 369 | - |
| catalog-plan-price | B/codex:gpt-6-luna:medium | 3/3 | 14.6 | 1 | 2 | 3 | 46,038 | 12,049 | 0.0012 | 29,952 | - | 6,868 | 258 | 4 |
| catalog-plan-price | A/codex:gpt-5.6-terra:medium | 3/3 | 27.8 | 9 | 10 | 11 | 124,272 | 29,289 | 0.0596 | 111,872 | - | 17,604 | 555 | - |
| catalog-plan-price | B/codex:gpt-5.6-terra:medium | 3/3 | 18.9 | 1 | 2 | 3 | 44,423 | 15,570 | 0.0319 | 35,840 | - | 10,241 | 407 | 4 |
| **Total** (8 tasks) | A/claude:claude-sonnet-5-5:medium | 24/24 | 70.5 | 41 | 43 | 43 | 454,895 | 85,277 | 0.171 | 430,116 | 21,142 | 86 | 2,993 | |
| **Total** (8 tasks) | B/claude:claude-sonnet-5-5:medium | 24/24 | 56.8 | 8 | 16 | 16 | 110,666 | 37,428 | 0.0749 | 97,014 | 10,811 | 32 | 2,834 | |
| **Total** (8 tasks) | A/codex:gpt-6-luna:medium | 23/24 | 153.6 | 47 | 55 | 63 | 666,790 | 156,272 | 0.0156 | 569,344 | - | 90,324 | 2,224 | |
| **Total** (8 tasks) | B/codex:gpt-6-luna:medium | 21/24 | 117.1 | 8 | 16 | 24 | 366,554 | 125,002 | 0.0125 | 263,680 | - | 88,115 | 2,058 | |
| **Total** (8 tasks) | A/codex:gpt-5.6-terra:medium | 24/24 | 177.2 | 48 | 56 | 64 | 771,547 | 175,659 | 0.358 | 677,632 | - | 95,238 | 3,107 | |
| **Total** (8 tasks) | B/codex:gpt-5.6-terra:medium | 17/24 | 126.9 | 8 | 16 | 24 | 324,739 | 101,372 | 0.209 | 256,768 | - | 59,896 | 3,207 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:medium | 8 | 24/24 | 56.8 | 8 | 16 | 16 | 37,428 | 0.0749 | list | 0.0749 |
| codex:gpt-6-luna:medium | 8 | 21/24 | 117.1 | 8 | 16 | 24 | 125,002 | 0.0125 | API-equiv | - |
| codex:gpt-5.6-terra:medium | 8 | 17/24 | 126.9 | 8 | 16 | 24 | 101,372 | 0.209 | API-equiv | - |

Host matrix, A Playwright MCP (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:medium | 8 | 24/24 | 70.5 | 41 | 43 | 43 | 85,277 | 0.171 | list | 0.171 |
| codex:gpt-6-luna:medium | 8 | 23/24 | 153.6 | 47 | 55 | 63 | 156,272 | 0.0156 | API-equiv | - |
| codex:gpt-5.6-terra:medium | 8 | 24/24 | 177.2 | 48 | 56 | 64 | 175,659 | 0.358 | API-equiv | - |

B/claude:claude-sonnet-5-5:medium receipts: 24; oversight rate 38% (9 with verdict.oversight other than none); auto-confirmed answers 15, false automation 0.

B/codex:gpt-6-luna:medium receipts: 24; oversight rate 54% (13 with verdict.oversight other than none); auto-confirmed answers 11, false automation 0.

B/codex:gpt-5.6-terra:medium receipts: 21; oversight rate 57% (12 with verdict.oversight other than none); auto-confirmed answers 9, false automation 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| A/claude:claude-sonnet-5-5:medium | 24 | 11 / 10 | 95 | 2,780 | 0.0213 | 0.0213 (24) | - (0) | 0 |
| B/claude:claude-sonnet-5-5:medium | 24 | 4 / 4 | 87 | 1,783 | 0.0103 | 0.0103 (24) | - (0) | 0 |
| A/codex:gpt-6-luna:medium | 24 | 11,507 / 11,087 | 86 | - | 0.0020 | 0.0020 (24) | - (0) | 0 |
| B/codex:gpt-6-luna:medium | 24 | 11,549 / 11,421 | 74 | - | 0.0016 | 0.0016 (24) | - (0) | 0 |
| A/codex:gpt-5.6-terra:medium | 24 | 11,986 / 11,887 | 87 | - | 0.0451 | 0.0451 (24) | - (0) | 0 |
| B/codex:gpt-5.6-terra:medium | 24 | 7,412 / 7,283 | 82 | - | 0.0263 | 0.0263 (24) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:medium (p25 of warm runs): A Playwright MCP 8 uncached, $0.0160; B FAI Browser 4 uncached, $0.0091.
Warm floor codex:gpt-6-luna:medium (p25 of warm runs): A Playwright MCP 7,638 uncached, $0.0014; B FAI Browser 6,617 uncached, $0.0012.
Warm floor codex:gpt-5.6-terra:medium (p25 of warm runs): A Playwright MCP 9,344 uncached, $0.0364; B FAI Browser 6,103 uncached, $0.0221.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

A/claude:claude-sonnet-5-5:medium / B/claude:claude-sonnet-5-5:medium over 8 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:medium is better): wall 1.24x, tool calls 5.13x, requests 2.69x (adjusted 2.69x), tokens 4.11x, priced 2.28x, cost 2.28x.

A/codex:gpt-6-luna:medium / B/codex:gpt-6-luna:medium over 8 shared task(s), all measured runs (>1 means B/codex:gpt-6-luna:medium is better): wall 1.31x, tool calls 5.88x, requests 3.44x (adjusted 2.63x), tokens 1.82x, priced 1.25x, cost 1.25x.

A/codex:gpt-5.6-terra:medium / B/codex:gpt-5.6-terra:medium over 8 shared task(s), all measured runs (>1 means B/codex:gpt-5.6-terra:medium is better): wall 1.40x, tool calls 6.00x, requests 3.50x (adjusted 2.67x), tokens 2.38x, priced 1.73x, cost 1.71x.

A/claude:claude-sonnet-5-5:medium / B/claude:claude-sonnet-5-5:medium over 8 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:medium is better): wall 1.24x, tool calls 5.13x, requests 2.69x (adjusted 2.69x), tokens 4.11x, priced 2.28x, cost 2.28x.

A/codex:gpt-6-luna:medium / B/codex:gpt-6-luna:medium over 8 shared task(s), warm runs only (>1 means B/codex:gpt-6-luna:medium is better): wall 1.31x, tool calls 5.88x, requests 3.44x (adjusted 2.63x), tokens 1.82x, priced 1.25x, cost 1.25x.

A/codex:gpt-5.6-terra:medium / B/codex:gpt-5.6-terra:medium over 8 shared task(s), warm runs only (>1 means B/codex:gpt-5.6-terra:medium is better): wall 1.40x, tool calls 6.00x, requests 3.50x (adjusted 2.67x), tokens 2.38x, priced 1.73x, cost 1.71x.

Warm-up runs (excluded): 6, cost $0.1473 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

Codex features off in both conditions: tool_suggest, skill_search, goals, sleep_tool, realtime_conversation (-c features.<name>=false).

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

