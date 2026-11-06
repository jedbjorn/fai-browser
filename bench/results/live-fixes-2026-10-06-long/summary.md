# Long-horizon corpus (live-fixes)

provider: daemon default (Jev); repeat 2; 28 runs.

| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| catalog-cheapest-tent | a | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 14 | 250 | 5.6 | 464 | - | - |
| catalog-cheapest-tent | b | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 38 | 257 | 8.9 | 741 | - | - |
| docs-deep-timeout | a | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 14 | 287 | 5.8 | 485 | - | - |
| docs-deep-timeout | b | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 22 | 238 | 7.0 | 584 | - | - |
| flights-live-form-arrows | a | 2 | 0 | 0 | 0 | 6 / 19 | 6 | 13.5 | 1 | 18 | 265 | 11.1 | 823 | low_confidence 2 | - |
| flights-live-form-arrows | b | 2 | 0 | 0 | 0 | 3 / 19 | 0 | 7 | 3 | 14 | 278 | 5.4 | 768 | low_confidence 2 | - |
| flights-live-landing-calendar | a | 2 | 0 | 0 | 0 | 4 / 29 | 4 | 16 | 1 | 18 | 283 | 13.5 | 841 | low_confidence 2 | - |
| flights-live-landing-calendar | b | 2 | 0 | 0 | 0 | 1 / 29 | 1 | 5 | 1 | 10 | 268 | 3.5 | 693 | expectation_mismatch 2 | - |
| flights-window-week | a | 2 | 2 | 2 | 2 | 13 / 13 | 13 | 13 | 1 | 15 | 270 | 5.0 | 382 | - | - |
| flights-window-week | b | 2 | 2 | 2 | 2 | 13 / 13 | 13 | 13 | 1 | 27 | 255 | 6.6 | 511 | - | - |
| wizard-shipping-draft | a | 2 | 2 | 2 | 2 | 15 / 15 | 15 | 15 | 1 | 17 | 252 | 5.9 | 391 | - | - |
| wizard-shipping-draft | b | 2 | 2 | 2 | 2 | 15 / 15 | 15 | 15 | 1 | 24 | 254 | 7.2 | 481 | - | - |
| workspace-deploy-token | a | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 14 | 261 | 4.5 | 373 | - | - |
| workspace-deploy-token | b | 2 | 2 | 2 | 2 | 12 / 12 | 12 | 12 | 1 | 22 | 253 | 6.1 | 506 | - | - |

| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | 14 | 10 | 10 | 10.57 | 10.57 | 1 | 15.71 | low_confidence 4 | low_confidence 4 | low_confidence 4 |
| b | 14 | 10 | 10 | 9.71 | 9.29 | 1.29 | 22.43 | low_confidence 2, expectation_mismatch 2 | low_confidence 2, expectation_mismatch 2 | low_confidence 2, expectation_mismatch 2 |

progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.
