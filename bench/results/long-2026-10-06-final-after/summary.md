# Long-horizon corpus

provider: daemon default (Jev); repeat 3; 30 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 252 | 5.4 | 446 | - | - |
| catalog-cheapest-tent | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 38 | 237 | 8.4 | 699 | - | - |
| docs-deep-timeout | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 242 | 5.3 | 441 | - | - |
| docs-deep-timeout | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 252 | 8.2 | 684 | - | - |
| flights-window-week | a | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 15 | 248 | 4.7 | 361 | - | - |
| flights-window-week | b | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 27 | 244 | 6.5 | 498 | - | - |
| wizard-shipping-draft | a | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 17 | 244 | 5.7 | 383 | - | - |
| wizard-shipping-draft | b | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 24 | 246 | 7.7 | 510 | - | - |
| workspace-deploy-token | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 247 | 4.2 | 354 | - | - |
| workspace-deploy-token | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 240 | 6.4 | 537 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 14.8 | - | - | - |
| b | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 26.6 | - | - | - |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
