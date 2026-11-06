# Long-horizon corpus

provider: daemon default (Jev); repeat 2; 20 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 14 | 244 | 5.3 | 446 | - | - |
| catalog-cheapest-tent | b | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 38 | 240 | 8.8 | 735 | - | - |
| docs-deep-timeout | a | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 14 | 252 | 5.4 | 447 | - | - |
| docs-deep-timeout | b | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 22 | 238 | 6.9 | 575 | - | - |
| flights-window-week | a | 2 | 2 | 2 | 2 | 13 / 13 | 13 | 13 | 1 | 15 | 246 | 4.6 | 357 | - | - |
| flights-window-week | b | 2 | 2 | 2 | 2 | 13 / 13 | 13 | 13 | 1 | 27 | 242 | 6.4 | 493 | - | - |
| wizard-shipping-draft | a | 2 | 2 | 2 | 2 | 15 / 15 | 15 | 15 | 1 | 17 | 246 | 5.9 | 391 | - | - |
| wizard-shipping-draft | b | 2 | 2 | 2 | 2 | 15 / 15 | 15 | 15 | 1 | 24 | 246 | 7.1 | 476 | - | - |
| workspace-deploy-token | a | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 14 | 244 | 4.2 | 348 | - | - |
| workspace-deploy-token | b | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 22 | 243 | 5.5 | 463 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 10 | 10 | 10 | 12.8 | 12.8 | 1 | 14.8 | - | - | - |
| b | 10 | 10 | 10 | 12.8 | 12.8 | 1 | 26.6 | - | - | - |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
