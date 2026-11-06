order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 1/1 | 6.2 | 1 | 2 | 2 | 16,185 | 4,961 | 0.0099 | 14,474 | 1,340 | 4 | 367 | 2 |
| about-members | R/claude:claude-sonnet-5-5:low | 1/1 | 6.0 | 1 | 2 | 2 | 38,145 | 6,684 | 0.0134 | 36,572 | 1,286 | 4 | 283 | 2 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 1/1 | 5.8 | 1 | 2 | 2 | 16,075 | 7,085 | 0.0142 | 12,276 | 3,499 | 4 | 296 | 1 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 1/1 | 5.9 | 1 | 2 | 2 | 38,120 | 12,140 | 0.0243 | 31,771 | 6,071 | 4 | 274 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 1/1 | 7.3 | 1 | 2 | 2 | 16,455 | 7,756 | 0.0155 | 12,295 | 3,802 | 4 | 354 | 3 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 1/1 | 8.9 | 1 | 2 | 2 | 38,456 | 12,684 | 0.0254 | 31,790 | 6,349 | 4 | 313 | 3 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 1/1 | 9.7 | 1 | 2 | 2 | 16,549 | 7,742 | 0.0155 | 12,282 | 3,948 | 4 | 315 | 4 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 1/1 | 7.1 | 1 | 2 | 2 | 38,665 | 13,077 | 0.0262 | 31,777 | 6,540 | 4 | 344 | 4 |
| slow-content | B/claude:claude-sonnet-5-5:low | 1/1 | 6.4 | 1 | 2 | 2 | 16,056 | 7,322 | 0.0146 | 12,307 | 3,370 | 4 | 375 | 0 |
| slow-content | R/claude:claude-sonnet-5-5:low | 1/1 | 6.2 | 1 | 2 | 2 | 38,104 | 12,444 | 0.0249 | 31,802 | 5,928 | 4 | 370 | 0 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 1/1 | 8.1 | 1 | 2 | 2 | 15,955 | 6,954 | 0.0139 | 12,292 | 3,353 | 4 | 306 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 1/1 | 14.8 | 1 | 2 | 2 | 38,003 | 11,986 | 0.0240 | 31,787 | 5,935 | 4 | 277 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 1/1 | 7.6 | 1 | 2 | 2 | 16,493 | 7,883 | 0.0158 | 12,301 | 3,811 | 4 | 377 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 1/1 | 6.5 | 1 | 2 | 2 | 38,399 | 12,651 | 0.0253 | 31,796 | 6,274 | 4 | 325 | 3 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 1/1 | 6.8 | 1 | 2 | 2 | 16,617 | 8,072 | 0.0161 | 12,307 | 3,918 | 4 | 388 | 4 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 1/1 | 7.0 | 1 | 2 | 2 | 38,681 | 13,177 | 0.0264 | 31,802 | 6,502 | 4 | 373 | 4 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 1/1 | 9.0 | 2 | 3 | 3 | 27,513 | 11,830 | 0.0237 | 21,505 | 5,423 | 6 | 579 | 4 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 1/1 | 12.9 | 2 | 3 | 3 | 61,028 | 18,418 | 0.0368 | 52,248 | 8,182 | 6 | 592 | 14 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 1/1 | 11.9 | 1 | 2 | 2 | 17,203 | 8,676 | 0.0174 | 12,468 | 4,328 | 4 | 403 | 6 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 1/1 | 18.0 | 2 | 3 | 3 | 60,317 | 18,143 | 0.0363 | 51,822 | 7,864 | 6 | 625 | 8 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 1/1 | 10.2 | 2 | 3 | 3 | 27,994 | 12,479 | 0.0250 | 21,656 | 5,694 | 6 | 638 | 5 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 1/1 | 10.4 | 2 | 3 | 3 | 60,210 | 18,029 | 0.0361 | 51,815 | 7,761 | 6 | 628 | 4 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 11/11 | 89.1 | 13 | 24 | 24 | 203,095 | 90,762 | 0.182 | 156,163 | 42,486 | 48 | 4,398 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 11/11 | 103.7 | 14 | 25 | 25 | 488,128 | 149,433 | 0.299 | 414,982 | 68,692 | 50 | 4,404 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 11/11 | 89.1 | 13 | 24 | 24 | 90,762 | 0.182 | list | 0.182 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 11/11 | 103.7 | 14 | 25 | 25 | 149,433 | 0.299 | list | 0.299 |

B/claude:claude-sonnet-5-5:low receipts: 13; oversight rate 54% (7 with verdict.oversight other than none); auto-confirmed answers 7, false automation 0.

R/claude:claude-sonnet-5-5:low receipts: 14; oversight rate 50% (7 with verdict.oversight other than none); auto-confirmed answers 7, false automation 1.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 13, of which with steps: 6.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 14, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 11 | 4 / 4 | 79 | 3,862 | 0.0165 | 0.0165 (11) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 11 | 5 / 4 | 86 | 6,245 | 0.0272 | 0.0272 (11) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0144; R FAI Browser (real install) 4 uncached, $0.0246.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.16x, tool calls 1.08x, requests 1.04x (adjusted 1.04x), tokens 2.40x, priced 1.65x, cost 1.65x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.16x, tool calls 1.08x, requests 1.04x (adjusted 1.04x), tokens 2.40x, priced 1.65x, cost 1.65x.

Warm-up runs (excluded): 2, cost $0.0388 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 11 R run(s): 0 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

