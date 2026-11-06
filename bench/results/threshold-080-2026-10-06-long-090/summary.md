# Long-horizon corpus

provider: daemon default (Jev); repeat 3; 30 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 253 | 5.7 | 471 | - | - |
| catalog-cheapest-tent | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 38 | 238 | 8.8 | 733 | - | - |
| docs-deep-timeout | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 237 | 5.4 | 454 | - | - |
| docs-deep-timeout | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 233 | 6.8 | 570 | - | - |
| flights-window-week | a | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 15 | 245 | 4.7 | 364 | - | - |
| flights-window-week | b | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 27 | 234 | 6.5 | 497 | - | - |
| wizard-shipping-draft | a | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 17 | 240 | 5.7 | 378 | - | - |
| wizard-shipping-draft | b | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 24 | 241 | 7.2 | 478 | - | - |
| workspace-deploy-token | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 235 | 4.1 | 342 | - | - |
| workspace-deploy-token | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 229 | 5.4 | 452 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 14.8 | - | - | - |
| b | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 26.6 | - | - | - |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
