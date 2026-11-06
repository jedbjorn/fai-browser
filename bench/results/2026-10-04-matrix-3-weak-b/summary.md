order: contiguous per host×condition, ABBA, warm-up 1 (about-members, excluded), stable paths

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B/codex:gpt-6-luna:medium | 3/3 | 11.1 | 1 | 2 | 3 | 31,649 | 7,565 | 0.0008 | 27,904 | - | 3,685 | 215 | 2 |
| about-members | B/codex:gpt-5.6-terra:medium | 3/3 | 12.3 | 1 | 2 | 3 | 29,783 | 14,545 | 0.0295 | 17,920 | - | 11,618 | 234 | 2 |
| pricing-pro | B/codex:gpt-6-luna:medium | 3/3 | 13.4 | 1 | 2 | 3 | 31,706 | 13,712 | 0.0014 | 20,736 | - | 10,728 | 208 | 2 |
| pricing-pro | B/codex:gpt-5.6-terra:medium | 3/3 | 13.7 | 1 | 2 | 3 | 30,221 | 7,711 | 0.0158 | 25,856 | - | 4,175 | 206 | 2 |
| docs-auth-header | B/codex:gpt-6-luna:medium | 3/3 | 13.8 | 1 | 2 | 3 | 35,365 | 16,960 | 0.0017 | 28,928 | - | 11,748 | 216 | 4 |
| docs-auth-header | B/codex:gpt-5.6-terra:medium | 3/3 | 13.0 | 1 | 2 | 3 | 30,471 | 8,141 | 0.0168 | 25,856 | - | 4,380 | 235 | 4 |
| catalog-p3-i5 | B/codex:gpt-6-luna:medium | 3/3 | 12.7 | 1 | 2 | 3 | 32,243 | 12,690 | 0.0013 | 27,904 | - | 6,779 | 211 | 4 |
| catalog-p3-i5 | B/codex:gpt-5.6-terra:medium | 3/3 | 12.3 | 1 | 2 | 3 | 30,704 | 13,875 | 0.0282 | 19,712 | - | 10,764 | 228 | 4 |
| slow-content | B/codex:gpt-6-luna:medium | 3/3 | 12.0 | 1 | 2 | 3 | 31,395 | 13,585 | 0.0014 | 20,736 | - | 10,446 | 213 | 2 |
| slow-content | B/codex:gpt-5.6-terra:medium | 3/3 | 12.8 | 1 | 2 | 3 | 29,972 | 7,646 | 0.0158 | 25,856 | - | 3,905 | 229 | 2 |
| settings-new-tab | B/codex:gpt-6-luna:medium | 3/3 | 14.5 | 2 | 3 | 4 | 42,013 | 13,840 | 0.0014 | 29,696 | - | 10,661 | 339 | 2 |
| settings-new-tab | B/codex:gpt-5.6-terra:medium | 3/3 | 11.7 | 1 | 2 | 3 | 30,073 | 8,813 | 0.0181 | 24,832 | - | 5,060 | 218 | 2 |
| docs-lead-guide | B/codex:gpt-6-luna:medium | 3/3 | 12.5 | 1 | 2 | 3 | 31,883 | 14,150 | 0.0014 | 20,736 | - | 10,916 | 230 | 3 |
| docs-lead-guide | B/codex:gpt-5.6-terra:medium | 3/3 | 12.5 | 1 | 2 | 3 | 30,482 | 9,147 | 0.0188 | 24,832 | - | 5,404 | 252 | 3 |
| catalog-plan-price | B/codex:gpt-6-luna:medium | 3/3 | 18.3 | 2 | 3 | 4 | 57,236 | 19,365 | 0.0019 | 40,960 | - | 13,257 | 321 | 3 |
| catalog-plan-price | B/codex:gpt-5.6-terra:medium | 3/3 | 13.9 | 1 | 2 | 3 | 30,786 | 8,536 | 0.0176 | 25,856 | - | 4,675 | 255 | 4 |
| **Total** (8 tasks) | B/codex:gpt-6-luna:medium | 24/24 | 108.3 | 10 | 18 | 26 | 293,490 | 111,865 | 0.0112 | 217,600 | - | 78,220 | 1,953 | |
| **Total** (8 tasks) | B/codex:gpt-5.6-terra:medium | 24/24 | 102.4 | 8 | 16 | 24 | 242,492 | 78,413 | 0.161 | 190,720 | - | 49,981 | 1,857 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| codex:gpt-6-luna:medium | 8 | 24/24 | 108.3 | 10 | 18 | 26 | 111,865 | 0.0112 | API-equiv | - |
| codex:gpt-5.6-terra:medium | 8 | 24/24 | 102.4 | 8 | 16 | 24 | 78,413 | 0.161 | API-equiv | - |

B/codex:gpt-6-luna:medium receipts: 26; oversight rate 65% (17 with verdict.oversight other than none); auto-confirmed answers 9, false automation 0.

B/codex:gpt-5.6-terra:medium receipts: 24; oversight rate 38% (9 with verdict.oversight other than none); auto-confirmed answers 15, false automation 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/codex:gpt-6-luna:medium | 24 | 9,109 / 10,695 | 75 | - | 0.0013 | 0.0013 (24) | - (0) | 0 |
| B/codex:gpt-5.6-terra:medium | 24 | 7,416 / 4,748 | 75 | - | 0.0222 | 0.0222 (24) | - (0) | 0 |

Warm floor codex:gpt-6-luna:medium (p25 of warm runs): B FAI Browser 4,931 uncached, $0.0010.
Warm floor codex:gpt-5.6-terra:medium (p25 of warm runs): B FAI Browser 4,318 uncached, $0.0165.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

Warm-up runs (excluded): 2, cost $0.0285 (about-members; records in warmup/runs.jsonl).

Codex features off in both conditions: tool_suggest, skill_search, goals, sleep_tool, realtime_conversation (-c features.<name>=false).

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

