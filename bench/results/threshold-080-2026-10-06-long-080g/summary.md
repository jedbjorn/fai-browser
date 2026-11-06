# Long-horizon corpus

provider: daemon default (Jev); repeat 3; 30 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 237 | 5.3 | 440 | - | - |
| catalog-cheapest-tent | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 38 | 243 | 8.8 | 730 | - | - |
| docs-deep-timeout | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 251 | 5.4 | 446 | - | - |
| docs-deep-timeout | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 246 | 7.1 | 593 | - | - |
| flights-window-week | a | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 15 | 254 | 5.3 | 406 | - | - |
| flights-window-week | b | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 27 | 239 | 6.3 | 486 | - | - |
| wizard-shipping-draft | a | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 17 | 238 | 5.6 | 374 | - | - |
| wizard-shipping-draft | b | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 24 | 242 | 7.2 | 479 | - | - |
| workspace-deploy-token | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 256 | 4.3 | 361 | - | - |
| workspace-deploy-token | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 242 | 5.6 | 467 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 14.8 | - | - | - |
| b | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 26.6 | - | - | - |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
