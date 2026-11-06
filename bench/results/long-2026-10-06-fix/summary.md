# Long-horizon corpus

provider: daemon default (Jev); repeat 3; 30 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 245 | 5.4 | 450 | - | - |
| catalog-cheapest-tent | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 38 | 245 | 8.7 | 728 | - | - |
| docs-deep-timeout | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 247 | 5.4 | 446 | - | - |
| docs-deep-timeout | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 248 | 7.4 | 618 | - | - |
| flights-window-week | a | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 15 | 251 | 4.7 | 360 | - | - |
| flights-window-week | b | 3 | 3 | 3 | 3 | 13 / 13 | 13 | 13 | 1 | 27 | 261 | 6.5 | 504 | - | - |
| wizard-shipping-draft | a | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 17 | 263 | 6.2 | 412 | - | - |
| wizard-shipping-draft | b | 3 | 3 | 3 | 3 | 15 / 15 | 15 | 15 | 1 | 24 | 242 | 7.1 | 475 | - | - |
| workspace-deploy-token | a | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 14 | 240 | 4.3 | 356 | - | - |
| workspace-deploy-token | b | 3 | 3 | 3 | 3 | 12 / 12 | 12 | 12 | 1 | 22 | 234 | 5.6 | 463 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 14.8 | - | - | - |
| b | 15 | 15 | 15 | 12.8 | 12.8 | 1 | 26.6 | - | - | - |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
