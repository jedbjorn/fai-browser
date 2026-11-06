order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths, claude cache TTL 5m (bench setting, not the subscription default)

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/claude:claude-sonnet-5-5:low | 3/3 | 6.2 | 1 | 2 | 2 | 16,134 | 4,859 | 0.0097 | 14,462 | 1,315 | 4 | 353 | 2 |
| about-members | R/claude:claude-sonnet-5-5:low | 3/3 | 6.0 | 1 | 2 | 2 | 38,136 | 6,694 | 0.0134 | 36,560 | 1,285 | 4 | 285 | 2 |
| pricing-pro | B/claude:claude-sonnet-5-5:low | 3/3 | 5.9 | 1 | 2 | 2 | 16,102 | 4,646 | 0.0093 | 14,440 | 1,358 | 4 | 300 | 1 |
| pricing-pro | R/claude:claude-sonnet-5-5:low | 3/3 | 5.8 | 1 | 2 | 2 | 38,101 | 6,627 | 0.0133 | 36,538 | 1,294 | 4 | 265 | 2 |
| docs-auth-header | B/claude:claude-sonnet-5-5:low | 3/3 | 8.2 | 1 | 2 | 2 | 16,420 | 5,217 | 0.0104 | 14,478 | 1,587 | 4 | 352 | 3 |
| docs-auth-header | R/claude:claude-sonnet-5-5:low | 3/3 | 7.3 | 1 | 2 | 2 | 38,447 | 7,184 | 0.0144 | 36,576 | 1,570 | 4 | 315 | 3 |
| catalog-p3-i5 | B/claude:claude-sonnet-5-5:low | 3/3 | 6.5 | 1 | 2 | 2 | 16,551 | 5,257 | 0.0105 | 14,452 | 1,778 | 4 | 317 | 4 |
| catalog-p3-i5 | R/claude:claude-sonnet-5-5:low | 3/3 | 6.5 | 1 | 2 | 2 | 38,597 | 7,293 | 0.0146 | 36,550 | 1,755 | 4 | 289 | 4 |
| slow-content | B/claude:claude-sonnet-5-5:low | 3/3 | 7.1 | 1 | 2 | 2 | 16,143 | 4,982 | 0.0100 | 14,502 | 1,245 | 4 | 388 | 3 |
| slow-content | R/claude:claude-sonnet-5-5:low | 3/3 | 8.6 | 1 | 2 | 2 | 38,175 | 7,017 | 0.0140 | 36,600 | 1,206 | 4 | 372 | 3 |
| settings-new-tab | B/claude:claude-sonnet-5-5:low | 3/3 | 8.1 | 1 | 2 | 2 | 15,949 | 4,447 | 0.0089 | 14,472 | 1,169 | 4 | 307 | 2 |
| settings-new-tab | R/claude:claude-sonnet-5-5:low | 3/3 | 5.7 | 1 | 2 | 2 | 38,004 | 6,515 | 0.0130 | 36,570 | 1,147 | 4 | 283 | 2 |
| docs-lead-guide | B/claude:claude-sonnet-5-5:low | 3/3 | 6.2 | 1 | 2 | 2 | 16,359 | 5,146 | 0.0103 | 14,490 | 1,514 | 4 | 354 | 3 |
| docs-lead-guide | R/claude:claude-sonnet-5-5:low | 3/3 | 7.1 | 1 | 2 | 2 | 38,400 | 7,160 | 0.0143 | 36,588 | 1,478 | 4 | 331 | 3 |
| catalog-plan-price | B/claude:claude-sonnet-5-5:low | 3/3 | 6.9 | 1 | 2 | 2 | 16,585 | 5,577 | 0.0112 | 14,502 | 1,710 | 4 | 397 | 4 |
| catalog-plan-price | R/claude:claude-sonnet-5-5:low | 3/3 | 9.7 | 1 | 2 | 2 | 38,675 | 7,700 | 0.0154 | 36,600 | 1,685 | 4 | 386 | 4 |
| billing-office-hours | B/claude:claude-sonnet-5-5:low | 3/3 | 9.6 | 2 | 3 | 3 | 27,681 | 9,589 | 0.0192 | 23,863 | 3,180 | 6 | 629 | 4 |
| billing-office-hours | R/claude:claude-sonnet-5-5:low | 3/3 | 15.9 | 2 | 3 | 3 | 61,726 | 17,587 | 0.0352 | 56,762 | 4,329 | 6 | 680 | 10 |
| office-plan-storage | B/claude:claude-sonnet-5-5:low | 3/3 | 9.6 | 1 | 2 | 2 | 17,175 | 8,790 | 0.0176 | 14,824 | 3,347 | 4 | 439 | 6 |
| office-plan-storage | R/claude:claude-sonnet-5-5:low | 3/3 | 10.2 | 2 | 3 | 3 | 60,156 | 12,688 | 0.0254 | 56,590 | 2,929 | 6 | 649 | 7 |
| office-showroom-page | B/claude:claude-sonnet-5-5:low | 3/3 | 13.7 | 2 | 3 | 3 | 26,638 | 10,924 | 0.0218 | 23,439 | 3,803 | 6 | 509 | 6 |
| office-showroom-page | R/claude:claude-sonnet-5-5:low | 3/3 | 17.2 | 4 | 5 | 5 | 108,292 | 29,640 | 0.0593 | 96,221 | 7,631 | 10 | 1,315 | 9 |
| **Total** (11 tasks) | B/claude:claude-sonnet-5-5:low | 33/33 | 87.9 | 13 | 24 | 24 | 201,737 | 69,431 | 0.139 | 177,924 | 22,006 | 48 | 4,345 | |
| **Total** (11 tasks) | R/claude:claude-sonnet-5-5:low | 33/33 | 99.9 | 16 | 27 | 27 | 536,709 | 116,104 | 0.232 | 502,155 | 26,309 | 54 | 5,170 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 87.9 | 13 | 24 | 24 | 69,431 | 0.139 | list | 0.139 |

Host matrix, R FAI Browser, real Claude Code install (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| claude:claude-sonnet-5-5:low | 11 | 33/33 | 99.9 | 16 | 27 | 27 | 116,104 | 0.232 | list | 0.232 |

B/claude:claude-sonnet-5-5:low receipts: 40; oversight rate 55% (22 with verdict.oversight other than none); auto-confirmed answers 18, false automation 3.

R/claude:claude-sonnet-5-5:low receipts: 48; oversight rate 52% (25 with verdict.oversight other than none); auto-confirmed answers 22 (4 on intermediate hops), false automation 3.

B/claude:claude-sonnet-5-5:low fai_browser_run calls: 41, of which with steps: 12.

R/claude:claude-sonnet-5-5:low fai_browser_run calls: 48, of which with steps: 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/claude:claude-sonnet-5-5:low | 33 | 4 / 4 | 86 | 2,519 | 0.0137 | 0.0137 (33) | - (0) | 0 |
| R/claude:claude-sonnet-5-5:low | 33 | 5 / 4 | 93 | 3,598 | 0.0227 | 0.0227 (33) | - (0) | 0 |

Warm floor claude:claude-sonnet-5-5:low (p25 of warm runs): B FAI Browser 4 uncached, $0.0100; R FAI Browser (real install) 4 uncached, $0.0140.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), all measured runs (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.14x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.66x, priced 1.67x, cost 1.67x.

R/claude:claude-sonnet-5-5:low / B/claude:claude-sonnet-5-5:low over 11 shared task(s), warm runs only (>1 means B/claude:claude-sonnet-5-5:low is better): wall 1.14x, tool calls 1.23x, requests 1.13x (adjusted 1.13x), tokens 2.66x, priced 1.67x, cost 1.67x.

Warm-up runs (excluded): 2, cost $0.0819 (about-members; records in warmup/runs.jsonl).

Claude prompt-cache TTL: 5m via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h).

R = real Claude Code install (--real-tools run): no inlined guidance, default tools, the installer's skill. Over 33 R run(s): 2 ToolSearch and 0 skill load(s); each is one more host request, already counted in Requests.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

