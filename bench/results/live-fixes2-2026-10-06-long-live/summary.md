# Long-horizon corpus

provider: daemon default (Jev); repeat 3; 12 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| flights-live-form-arrows | a | 3 | 0 | 2 | 0 | 5 / 19 | 5 | 14.67 | 1 | 17.67 | 284 | 21.5 | 1132 | unreadable_region 2, low_confidence 1 | - |
| flights-live-form-arrows | b | 3 | 3 | 3 | 3 | 6 / 19 | 6 | 20 | 1 | 57.33 | 269 | 27.5 | 1374 | - | - |
| flights-live-landing-calendar | a | 3 | 0 | 0 | 0 | 4 / 29 | 4 | 14 | 1 | 15 | 279 | 14.7 | 1052 | low_confidence 3 | - |
| flights-live-landing-calendar | b | 3 | 1 | 3 | 1 | 8.33 / 29 | 4.67 | 42 | 5.67 | 89 | 269 | 40.9 | 984 | expectation_mismatch 2, cap_actions 1 | maxActions 2 |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 6 | 0 | 0 | 4.5 | 4.5 | 1 | 16.33 | low_confidence 4, unreadable_region 2 | low_confidence 4 | low_confidence 4, expectation_passed 2 |
| b | 6 | 4 | 4 | 7.17 | 5.33 | 3.33 | 73.17 | expectation_mismatch 2, cap_actions 1 | expectation_mismatch 2, cap_actions 1 | expectation_failed 2, action_budget 1 |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
