# QA corpus run

4 tasks, 12 runs, repeat 3. Pass 10/12 (83%). p50 run 651 ms, p90 854 ms. Jev decisions 24, tokens in 36569 / out 4903. Danger clicks 0, receipts offering a dangerous choice 0, violations 0, auto-answers 9, false automations 0.

- verdictKind: verified 10, needs_decision 2
- oversight: none 9, instruct 2, confirm 1
- nextKind: answer 9, rerun 2, answer_from_digest 1
- status/code: completed/expectation_passed 10, needs_host/placeholder_unconfirmed 2
- failures: outcome:status 2
- guards at or above the 0.85 veto level: blocked [], injection []
- hand-backs (next rerun, split or choose): 2/12, of which rerun 2; provider requests per run 3
- in-call retries: 0 runs; none
- host calls (FAI calls a host makes): 14 over 12 runs (mean 1.17); step-list tasks (--steps on): 5 over 3 runs (mean 1.67), pass 1/3
- site profile: 0 runs used one, 0 took fast steps (0 steps, 0 hints); fell back: none
- vague tasks: 0 runs, 0 with verdict.suggested, 0 whose suggested.expectation names the gold page

## Provider requests

| kind | requests | errors | discarded | p50 ms | p90 ms | mean tokens in | mean tokens out | mean options | capped | fallbacks | mean chars (total: controls / options / text / policy / questions) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| choose | 12 | 0 | 0 | 232 | 290 | 438 | 38 | 3 | 0 | 0 | 687: 0 / 100 / 0 / 0 / 397 |
| decide_executed | 11 | 0 | 0 | 238 | 297 | 1260 | 189 | 10 | 0 | 0 | 3222: 444 / 382 / 140 / 928 / 1030 |
| decide_terminal | 13 | 0 | 0 | 254 | 345 | 1342 | 182 | 10 | 0 | 0 | 3295: 474 / 394 / 134 / 922 / 949 |

## By archetype

| archetype | runs | pass | p50 ms | decisions | danger | false auto |
|---|---|---|---|---|---|---|
| docs | 3 | 1 (33%) | 465 | 6 | 0 | 0 |
| select | 3 | 3 (100%) | 627 | 6 | 0 | 0 |
| spa | 6 | 6 (100%) | 700 | 12 | 0 | 0 |

## By hops and kind

| group | runs | pass | p50 ms |
|---|---|---|---|
| hops 1 | 9 | 100% | 675 |
| hops 2 | 3 | 33% | 465 |
| positive | 12 | 83% | 651 |

## By task

| task | kind | hops | pass | p50 ms | decisions | tokens in | status/code | verdict | next | failure |
|---|---|---|---|---|---|---|---|---|---|---|
| spa-reports-pushstate | positive | 1 | 3/3 | 725 | 2 | 2986 | completed/expectation_passed 3 | verified 3 | answer 3 |  |
| spa-billing-balance | positive | 1 | 3/3 | 575 | 2 | 3078 | completed/expectation_passed 3 | verified 3 | answer 3 |  |
| select-oceania | positive | 1 | 3/3 | 627 | 2 | 2931 | completed/expectation_passed 3 | verified 3 | answer 3 |  |
| steps-docs-featured-join | positive | 2 | 1/3 | 465 | 1 | 1697 | needs_host/placeholder_unconfirmed 2, completed/expectation_passed 1 | needs_decision 2, verified 1 | rerun 2, answer_from_digest 1 | outcome:status 2 |
