# QA corpus run

4 tasks, 12 runs, repeat 3. Pass 9/12 (75%). p50 run 573 ms, p90 763 ms. Jev decisions 21, tokens in 29877 / out 4161. Danger clicks 0, receipts offering a dangerous choice 0, violations 0, auto-answers 0, false automations 0.

- verdictKind: verified 9, needs_decision 3
- oversight: confirm 9, instruct 3
- nextKind: answer_from_digest 9, rerun 3
- status/code: completed/expectation_passed 9, needs_host/placeholder_unconfirmed 3
- failures: outcome:status 3
- guards at or above the 0.85 veto level: blocked [], injection []
- hand-backs (next rerun, split or choose): 3/12, of which rerun 3; provider requests per run 2.25
- in-call retries: 0 runs; none
- host calls (FAI calls a host makes): 15 over 12 runs (mean 1.25); step-list tasks (--steps on): 6 over 3 runs (mean 2), pass 0/3
- site profile: 0 runs used one, 0 took fast steps (0 steps, 0 hints); fell back: none
- vague tasks: 0 runs, 0 with verdict.suggested, 0 whose suggested.expectation names the gold page

## Provider requests

| kind | requests | errors | discarded | p50 ms | p90 ms | mean tokens in | mean tokens out | mean options | capped | fallbacks | mean chars (total: controls / options / text / policy / questions) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| choose | 6 | 0 | 0 | 224 | 254 | 469 | 38 | 3 | 0 | 0 | 774: 0 / 112 / 0 / 0 / 397 |
| decide_executed | 9 | 0 | 0 | 229 | 677 | 1245 | 194 | 9 | 0 | 0 | 3334: 364 / 357 / 138 / 1054 / 1147 |
| decide_terminal | 12 | 0 | 0 | 251 | 334 | 1322 | 183 | 10 | 0 | 0 | 3282: 457 / 382 / 133 / 925 / 987 |

## By archetype

| archetype | runs | pass | p50 ms | decisions | danger | false auto |
|---|---|---|---|---|---|---|
| docs | 3 | 0 (0%) | 280 | 3 | 0 | 0 |
| select | 3 | 3 (100%) | 559 | 6 | 0 | 0 |
| spa | 6 | 6 (100%) | 716 | 12 | 0 | 0 |

## By hops and kind

| group | runs | pass | p50 ms |
|---|---|---|---|
| hops 1 | 9 | 100% | 641 |
| hops 2 | 3 | 0% | 280 |
| positive | 12 | 75% | 573 |

## By task

| task | kind | hops | pass | p50 ms | decisions | tokens in | status/code | verdict | next | failure |
|---|---|---|---|---|---|---|---|---|---|---|
| spa-reports-pushstate | positive | 1 | 3/3 | 738 | 2 | 2605 | completed/expectation_passed 3 | verified 3 | answer_from_digest 3 |  |
| spa-billing-balance | positive | 1 | 3/3 | 641 | 2 | 2669 | completed/expectation_passed 3 | verified 3 | answer_from_digest 3 |  |
| select-oceania | positive | 1 | 3/3 | 559 | 2 | 2988 | completed/expectation_passed 3 | verified 3 | answer_from_digest 3 |  |
| steps-docs-featured-join | positive | 2 | 0/3 | 280 | 1 | 1697 | needs_host/placeholder_unconfirmed 3 | needs_decision 3 | rerun 3 | outcome:status 3 |
