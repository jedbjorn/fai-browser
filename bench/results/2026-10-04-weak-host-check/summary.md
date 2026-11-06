order: contiguous per host×condition, ABBA, warm-up 0, stable paths

| Task | Condition | Pass | Wall s | Tool calls | Requests | Req. adj. | Tokens (in+out) | Priced | Cost $ | Cached in | Cache write | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pricing-pro | B/codex:gpt-5.6-terra:medium | 1/1 | 9.5 | 1 | 2 | 3 | 30,142 | 7,628 | 0.0156 | 25,856 | - | 4,097 | 189 | 2 |
| pricing-pro | B/codex:gpt-6-luna:medium | 1/1 | 14.9 | 1 | 2 | 3 | 31,570 | 9,024 | 0.0009 | 25,856 | - | 5,533 | 181 | 2 |
| docs-auth-header | B/codex:gpt-5.6-terra:medium | 1/1 | 8.8 | 1 | 2 | 3 | 30,498 | 8,340 | 0.0172 | 25,856 | - | 4,364 | 278 | 4 |
| docs-auth-header | B/codex:gpt-6-luna:medium | 1/1 | 22.7 | 2 | 3 | 4 | 42,655 | 10,060 | 0.0010 | 37,888 | - | 4,391 | 376 | 4 |
| slow-content | B/codex:gpt-5.6-terra:medium | 1/1 | 11.7 | 1 | 2 | 3 | 29,944 | 7,622 | 0.0157 | 25,856 | - | 3,851 | 237 | 2 |
| slow-content | B/codex:gpt-6-luna:medium | 1/1 | 14.3 | 1 | 2 | 3 | 31,307 | 8,857 | 0.0009 | 25,856 | - | 5,246 | 205 | 2 |
| docs-lead-guide | B/codex:gpt-5.6-terra:medium | 1/1 | 11.9 | 1 | 2 | 3 | 30,483 | 8,377 | 0.0173 | 25,856 | - | 4,336 | 291 | 3 |
| docs-lead-guide | B/codex:gpt-6-luna:medium | 1/1 | 12.6 | 1 | 2 | 3 | 31,802 | 14,040 | 0.0014 | 20,736 | - | 10,841 | 225 | 3 |
| **Total** (4 tasks) | B/codex:gpt-5.6-terra:medium | 4/4 | 41.9 | 4 | 8 | 12 | 121,067 | 31,965 | 0.0659 | 103,424 | - | 16,648 | 995 | |
| **Total** (4 tasks) | B/codex:gpt-6-luna:medium | 4/4 | 64.5 | 5 | 9 | 13 | 137,334 | 41,980 | 0.0042 | 110,336 | - | 26,011 | 987 | |

Host matrix, B FAI Browser (totals over attempted tasks):

| Host | Tasks | Pass | Wall s | Tool calls | Requests | Req. adj. | Priced | Cost $ | Basis | Reported $ |
|---|---|---|---|---|---|---|---|---|---|---|
| codex:gpt-5.6-terra:medium | 4 | 4/4 | 41.9 | 4 | 8 | 12 | 31,965 | 0.0659 | API-equiv | - |
| codex:gpt-6-luna:medium | 4 | 4/4 | 64.5 | 5 | 9 | 13 | 41,980 | 0.0042 | API-equiv | - |

B/codex:gpt-5.6-terra:medium receipts: 4; oversight rate 25% (1 with verdict.oversight other than none); auto-confirmed answers 3, false automation 1.

B/codex:gpt-6-luna:medium receipts: 4; oversight rate 25% (1 with verdict.oversight other than none); auto-confirmed answers 3, false automation 0.

Prompt cache per host×condition (measured runs; warm-up excluded):

| Condition | Runs | Uncached in (mean/median) | Cached % | Cache write (mean) | Cost $ (mean) | Cost warm (mean, n) | Cost cold (mean, n) | Unknown phase |
|---|---|---|---|---|---|---|---|---|
| B/codex:gpt-5.6-terra:medium | 4 | 4,162 / 4,217 | 86 | - | 0.0165 | 0.0168 (3) | 0.0156 (1) | 0 |
| B/codex:gpt-6-luna:medium | 4 | 6,503 / 5,390 | 81 | - | 0.0010 | 0.0011 (3) | 0.0009 (1) | 0 |

Warm floor codex:gpt-5.6-terra:medium (p25 of warm runs): B FAI Browser 4,094 uncached, $0.0165.
Warm floor codex:gpt-6-luna:medium (p25 of warm runs): B FAI Browser 4,819 uncached, $0.0009.

Cold = first run of a host×condition timeline with no warm-up before it, a gap over the cache TTL, or the host's previous run used the other condition. Unknown = records written before cache phases were recorded (not counted as cold).

Codex features off in both conditions: tool_suggest, skill_search, goals, sleep_tool, realtime_conversation (-c features.<name>=false).

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match (tasks with expectOutcome: the final FAI result status/code); see summary.json for passLoose. Requests are model requests: inferred from the Codex event stream, distinct assistant message ids for Claude. Req. adj. (requestsAdjusted) adds 1 to a Codex run with an MCP tool call: the deferred schema load the stream does not show. Tokens (in+out) count cached input and cache writes in full; token counts are per vendor tokenizer, so compare cost, time and accuracy across vendors. Priced = uncached x 1 + cached x 0.1 + cache write x 1.25 + output x 5 (assumed weights). Cost $ uses bench/prices.json: list prices for Claude, API-equivalent for Codex (a ChatGPT plan bills quota, not dollars).

