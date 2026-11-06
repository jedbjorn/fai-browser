# Long-horizon corpus

provider: daemon default (Jev); repeat 1; 10 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 1 | 1 | 1 | 1 | 12 / 12 | 12 | 12 | 1 | 14 | 278 | 5.8 | 486 | - | - |
| catalog-cheapest-tent | b | 1 | 1 | 1 | 1 | 12 / 12 | 12 | 12 | 1 | 38 | 249 | 9.1 | 762 | - | - |
| docs-deep-timeout | a | 1 | 1 | 1 | 1 | 12 / 12 | 12 | 12 | 1 | 14 | 273 | 5.6 | 468 | - | - |
| docs-deep-timeout | b | 1 | 1 | 1 | 1 | 12 / 12 | 12 | 12 | 1 | 22 | 262 | 7.7 | 645 | - | - |
| flights-window-week | a | 1 | 1 | 1 | 1 | 13 / 13 | 13 | 13 | 1 | 15 | 273 | 5.1 | 394 | - | - |
| flights-window-week | b | 1 | 1 | 1 | 1 | 13 / 13 | 13 | 13 | 1 | 27 | 280 | 6.8 | 524 | - | - |
| wizard-shipping-draft | a | 1 | 1 | 1 | 1 | 15 / 15 | 15 | 15 | 1 | 17 | 294 | 6.4 | 426 | - | - |
| wizard-shipping-draft | b | 1 | 1 | 1 | 1 | 15 / 15 | 15 | 15 | 1 | 24 | 279 | 7.5 | 502 | - | - |
| workspace-deploy-token | a | 1 | 1 | 1 | 1 | 12 / 12 | 12 | 12 | 1 | 14 | 276 | 4.7 | 390 | - | - |
| workspace-deploy-token | b | 1 | 1 | 1 | 1 | 12 / 12 | 12 | 12 | 1 | 22 | 277 | 6.2 | 513 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 5 | 5 | 5 | 12.8 | 12.8 | 1 | 14.8 | - | - | - |
| b | 5 | 5 | 5 | 12.8 | 12.8 | 1 | 26.6 | - | - | - |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
