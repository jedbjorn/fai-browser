# Long-horizon corpus

provider: daemon default (Jev); repeat 3; 30 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 3 | 0 | 3 | 0 | 12 / 12 | 12 | 12 | 1 | 14 | 241 | 5.2 | 436 | unreadable_region 3 | - |
| catalog-cheapest-tent | b | 3 | 0 | 0 | 0 | 6.33 / 12 | 4 | 6.33 | 2 | 12.67 | 251 | 3.6 | 602 | cap_actions 3 | steps 3, maxActions 3 |
| docs-deep-timeout | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 251 | 5.4 | 449 | - | - |
| docs-deep-timeout | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 230 | 6.9 | 579 | - | - |
| flights-window-week | a | 3 | 0 | 3 | 0 | 13 / 13 | 13 | 13 | 1 | 15 | 250 | 5.1 | 394 | unreadable_region 3 | - |
| flights-window-week | b | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 2 | 27 | 243 | 6.2 | 476 | - | steps 3 |
| wizard-shipping-draft | a | 3 | 1 | 1 | 1 | 14.33 / 15 | 14.33 | 14.33 | 1 | 15.67 | 233 | 5.2 | 368 | low_confidence 1, provider_handoff_on_offered_control 1 | steps 1 |
| wizard-shipping-draft | b | 3 | 0 | 0 | 0 | 3 / 15 | 0 | 8.33 | 6 | 11.33 | 231 | 4.2 | 489 | cap_calls 3 | steps 3, maxCalls 3 |
| workspace-deploy-token | a | 3 | 0 | 3 | 0 | 12 / 12 | 12 | 12 | 1 | 13 | 239 | 4.1 | 340 | unreadable_region 3 | - |
| workspace-deploy-token | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 230 | 5.8 | 480 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 15 | 4 | 4 | 12.67 | 12.67 | 1 | 14.33 | unreadable_region 9, low_confidence 1, provider_handoff_on_offered_control 1 | low_confidence 1, provider_handoff_on_offered_control 1 | handoff_expectation_passed 5, expectation_passed 4, low_confidence 1, handoff 1 |
| b | 15 | 9 | 9 | 9.27 | 8.2 | 2.4 | 19 | cap_actions 3, cap_calls 3 | cap_actions 3, provider_handoff_on_offered_control 3 | action_budget 3, task_budget 3 |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
