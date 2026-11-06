# Long-horizon corpus

Seven offline tasks of 12-29 hops each (the original five, plus two live-like flights variants), modelled on the shapes that break long tasks live (Google Flights loops,
paginated aggregation, button-only SPAs, deep docs trees, form wizards), and a runner that drives FAI Browser with Jev
directly (no coding agent) and measures how many hops a chain survives, why it breaks and how many host turns it costs.
It is the yardstick for engine changes that chain more small hops inside the daemon.

```sh
node bench/long/run.mjs --list
node bench/long/run.mjs --dry-run --browser                      # validate, and walk every gold path with plain Chromium
FAI_HOME=<checkout with .env.local> node bench/long/run.mjs --repeat 3 --label baseline   # live Jev, conditions a and b
node bench/long/run.mjs --sim-jev --tasks docs-deep-timeout      # mechanics only (no key)
node bench/long/run.mjs --report bench/results/long-<stamp>[,<another>]   # regrade and print the table
node bench/long/run.mjs --regrade bench/results/long-<stamp>     # rewrite its grades, summary.json and summary.md
node --test test/long-corpus.test.js
```

Options: `--tasks id,id`, `--conditions a,b` (default both), `--repeat N`, `--out DIR` (default
`bench/results/long-<stamp>[-label]/`), `--label X`, `--sim-jev [ms]` (bench/qa/sim-jev.mjs; pass rates under it mean
nothing), `--steps on|off` (condition b sends lists of up to 15 steps (`MAX_STEPS`), or one step per call), `--profile on|off` (the QA
fixture profile and the run's `profiles` switch, as in bench/qa), `--retry on|off`, `--timeout-ms N` (run timeout; default:
what MCP sends, nothing, so the runtime's 30 s single / 45 s list, clamped to the request's time budget), `--max-calls N`
and `--max-ms N` (the emulated MCP request budget, default 6 calls / 120 s), `--capture each|last|none`, `--thresholds JSON` (the run body's gate thresholds, e.g. `'{"answerConfirm":0.9}'` for a before/after of one gate with the same tree; `act` calls keep the defaults).
`--tree PATH` runs another checkout's product (for example a worktree of an earlier tag, which may predate this
runner): its `src/` daemon, SDK client, receipt shaping and step caps (`MAX_STEPS`, the single-run `maxActions` cap, the
list timeout) and its `extension/`, with this checkout's corpus, runner and grader. Pass `FAI_HOME` (the tree's own
root has no `.env.local`). `config.json` records the tree and its `git describe`.

The session is bench/qa/session.mjs: an isolated daemon on a random port (never 4318) with a scratch `FAI_DAEMON_DIR`,
headless Chromium with the test manifest, approval through the popup at the task's mode. `FAI_HOME` is taken from the
environment (default: the package root); the daemon reads the Jev key from `$FAI_HOME/.env.local` itself.

## Tasks (`bench/long/tasks.json`, pages in `fixtures/long/`, served at `/long/` by bench/qa/serve.mjs)

| id | mode | hops | shape | answer |
|---|---|---|---|---|
| `flights-window-week` | reversible | 13 | 7 day buttons, each day's 10:00-12:00 flights behind "Show 4 more flights"; a date grid table and an aria-hidden SVG price graph give the any-time minimum (decoy) | VY 7713 (Thu 10:55, €61) |
| `catalog-cheapest-tent` | read-only | 12 | 13 pages via Next page; minimum over pages with out-of-stock and accessory decoys | Larkspur 2P tent €129 |
| `workspace-deploy-token` | reversible | 12 | button-only SPA, URL never changes: Projects > more > Keel > Environments > Staging > Deploys > older > #318 > Logs, then Settings > Integrations > Webhooks; Delete workspace decoy | RB-7Q2K |
| `docs-deep-timeout` | read-only | 12 | docs 9 levels deep, three right links only on a table of contents' page 2, breadcrumbs, legacy/v2/TCP decoys | 2500 ms |
| `wizard-shipping-draft` | reversible | 15 | 7-step wizard: 9 supplied-text fills and a select, harmless Next buttons, a Submit order decoy; the reference hashes every value | DR-1GBZTRB |
| `flights-live-form-arrows` | reversible | 19 | live-like search form (autocomplete destination, read-only Departure textbox, calendar dialog, Done, Search), then 6 unnamed next-day arrow clicks whose effect lands 1.5 s later, "View more flights" every day | easyJet 10:40 AM €58 (Thu 15 Oct) |
| `flights-live-landing-calendar` | reversible | 29 | starts on a city marketing page with its own search form; each day is picked in the Departure calendar dialog, then "View more flights" | easyJet 10:40 AM €58 (Thu 15 Oct) |

## The live-like flights variant (`fixtures/long/flights-live`)

`fixtures/long/flights` (task `flights-window-week`) passed 15/15 while a real Google Flights run of the same question took
21 host turns: the fixture did not look like the live site. It stays unchanged so docs/results/RESULTS.md comparisons hold; the
two `flights-live-*` tasks run on a separate, live-like fixture that has what broke live (diagnosis of run gf-week-window,
2026-10-06):

- results headings "Top flights" / "Other flights" and a "Track prices ... departing YYYY-MM-DD" sentence, never
  "Departing flights"; the date is in the URL as base64 `tfs` (the "-10-13" fragment always reads `LTEwLTEz`) and
  `&tfu=...` is appended once the results are in;
- the Departure field is a read-only textbox that opens a calendar dialog (per-day lowest fares, "Done"), flanked by
  two unnamed arrow buttons (bare SVG icons: "unlabelled button 1 of 2 / 2 of 2 next to Departure");
- a date change (arrow or Done) lands 1.5 s after the click, which itself settles quiet with nothing changed; the new
  day first paints half ("Top options", rows with times only) and settles 0.6 s later; the first load does the same;
- "View more flights" with no counts (each day's cheapest 10:00-12:00 row is behind it; without it the week's minimum
  reads Sat Vueling 10:15 AM €76); after expanding, the button becomes "Hide flights" (the route mark);
- a visually hidden `role=status` "Loading results" (and "Fetching results") that never goes away;
- rows as 12-hour ranges with "+1", "Operated by" and an Air France/Eurostar rail mix, no flight numbers, so the
  answers are airline + time + price (`expected` easyJet, 10:40, 58; `derivable` each day's cheapest row as its range);
- a search-form start page (`index.html`, with a "London" card linking to the marketing page) and a marketing page
  (`flights-to-london.html`: route facts, "from €34", FAQ and its own search form).

The gold path (`oracle.actions`) clicks the calendar day buttons and the arrows by selector; `runLongOracle` polls a
route mark for up to 4 s (`markWaitMs`) because of the late re-render.

Baseline on main (0dcf10b, `--tree`, x1, `bench/results/long-2026-10-06T08-32-40-673Z-live-main-0dcf10b`): both tasks
fail in both conditions within the first two hops, the way the live run did: the Departure textbox is offered only as
a fill target, so no "open the date field" action exists (a: `low_confidence` after the destination; the marketing page
start hands off at once; b: the emulated host's `choose` picks the "London" card or "Search all flights" and runs out
of calls). On this branch (E7 merged with main 0dcf10b, x1, `bench/results/long-2026-10-06T08-36-39-238Z-live-branch-e7`) the result is the
same, as expected: the break is upstream of what E7 changes (the date field and the arrows). They are meant to fail on main: they give the date-field, arrow-label, late-change and loading-status fixes
(E1-E5) something to pass, and the per-day answer scope and View-more expansion (E7) something to aggregate over.

Each task has `instruction`, `expectation` and `answerQuestion` (condition a), `steps` (condition b, any length,
chunked into calls of `MAX_STEPS`, 15), `route` (where hop N lands: `path`, an exact pathname, or `text`, case-sensitive page text,
plus `control`, the label the hop clicks), `oracle.actions` (the gold path, one action per hop) and `oracle.text`,
`expected` with `match`, and for aggregates `derivable` (the facts a host must see to compute the answer).

## Conditions and the emulated host

- **a (naive host).** One run: the whole instruction, the final-page expectation, the question, `maxActions` = 2 per
  hop capped at 60 (the MCP cap for one run; 30 before round 6, which no task reached). No follow-up call.
- **b (careful host).** The task's steps in lists of at most 15 (`MAX_STEPS`; 5 before round 6). The host follows `next` literally and has no model:
  `next.steps` are resent (with `{{supply:N}}` filled from that step's answer or top candidate), a rerun, split or
  confirm_page with `verdict.suggested.instruction` runs it for the current step, `choose` acts on the option whose label
  shares most words with the step (`fai_browser_act`, then the remaining steps unless the act passed the step), and anything else (relay, stop, a rerun without a ready instruction, an identical
  repeat that MCP refuses after needs_host/unverified/budget_exhausted) ends the task. Before each call the MCP request
  budget (6 run/act calls, 120 s of run time) is checked; each extra 43 s of one call counts one `fai_browser_wait` turn.

## Metrics (runs.jsonl, summary.json, summary.md)

Per run: `success` (every call completed and verified, answer correct, no danger click or violation), `verified`,
`answerOk` (auto answer, or every derivable fact in the receipts' digests, trails, step answers and candidates),
`progressHop` (gold-path hop of the last route mark met in order over every observed page), `hopsBeforeBreak`
(survival: the same, up to the end of the first call that was not completed and verified), `hopsExecuted` (page actions,
wrong turns included), host turns, Jev requests and p50 latency, wall per task and per hop, `caps` (which cap fired:
`steps`, `maxActions`, `maxCalls`, `maxMs`, `wait45`, `runTimeout`), `break` `{class, code, why}` (how the task ended) and
`firstBreak` (the class of the first call that was not completed and verified; a later `cap_calls` stop often hides
the handoff that started the loop), from:

| class | when |
|---|---|
| `provider_handoff_on_offered_control` | handoff while the control the next route mark needs was offered on the page |
| `low_confidence`, `no_progress`, `stale_loop` | codes low_confidence, no_progress, stale |
| `expectation_mismatch` | unverified: expectation_mismatch / expectation_failed |
| `unreadable_region` | every call verified but the needed facts never reached the receipts (digest/trail lost them) |
| `cap_steps` | next.kind split (the engine's per-run hop limit) |
| `cap_actions`, `cap_time` | action/decision budget, run time budget |
| `cap_calls` | the emulated MCP call or time budget stopped the host |
| `wrong_answer` | verified, but the auto answer is wrong |
| `consent/login/blocked` | consent_banner, login, blocked, refused_action, blocked_risky |
| `other` | anything else; a handoff whose needed control was not offered has `detail: handoff_control_not_offered` |
