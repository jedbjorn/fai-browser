# Phase 1 independent review

Specification: docs/design/PROPOSAL.md sections 3, 4, 5, with Phase 1 scope from section 9.
No headed browser, commits, or reads/copies of real environment files. CLI subprocess tests use a new empty FAI_HOME.

Full command output and initial failing reproductions are in `artifacts/codex-review/`.
Baseline system Node v24.21.0: 108 tests, 108 passed, 0 failed. Headless extension smoke passed.
After changes: 123 tests, 121 passed, 2 failed. Headless extension smoke passed.
Final validation uses both system Node v24.21.0 and an explicit Node v22.23.3 binary.
An npm-exec attempt initially fell back to Node 24 because package install scripts were disabled; its output is not treated as Node 22 evidence.
One intermediate overlapping test run collided on the cleanup tests' fixed port 4318; the sequential final run has only the two documented failures.

## Remaining failures and proposed fixes

- `codex: echoed supplied values never enter TypeSafe request including history`: a form preview or control label reflects the supplied value. The next provider payload includes it in page text, criteria, and subsequently history labels. Existing tests omit observation from their leakage check and use a fixture without a preview. Fix at the runtime/provider boundary, sanitizing page fields, action criteria, and history before any provider receives them. Define the treatment of short/common supplied strings and encoded echoes before implementing; dropping command.text alone is insufficient.
- `codex: changedSinceStart can verify a changed revision`: the spec's field is rejected outright. Implement an initial-observation baseline for run/step/act, extend validation and public expectation types, and define behavior when standalone expectation helpers have no initial observation. This requires a feature/API decision beyond a local correctness fix.

## Claim audit

| Claim | Evidence and conclusion |
| --- | --- |
| Exactly maxActions actions can complete | Existing runtime regression passes; expectation is evaluated before budget handling. |
| Stale/target_unavailable recover, third stale hands off | Existing runtime and worker regressions pass. Step defaults to two decisions, so two stale attempts exhaust that budget; runs allow three attempts. |
| Capture overlaps next decision / none never captures / failure preserves step | Runtime overlap and failure tests, companion screenshot-order tests, worker tests, and extension smoke pass. Capture gate correctly prevents the next execute changing a frame before capture; screenshot quota can still pace actions. |
| Host observe/act executes offered action and rejects unknown/reused offers | Existing tests pass; new mutation test found suppliedText retained by reference. Fixed with configuration snapshots. |
| Every BridgeError status and CLI exit | New CLI test injects all 14 codes through real authenticated HTTP companion requests and checks actual subprocess stdout/exit. All pass. |
| Reserved actions survive cap, toggles clickable | Existing cap test passes. New regression found dangerous-word filtering wrongly removed checkbox/radio actions; fixed to buttons only. |
| Form text absent from provider payload/history | Direct command values are absent; reflected page/label values leak. Remaining failing test checks the actual TypeSafe POST body including history. |
| Expectations validated early, insensitive includes/absent, URL regex, undefined text | Runtime tests pass. CLI validation was delayed until tab selection; fixed and tested. changedSinceStart remains missing. |
| Retry once on 429/5xx/network, no retry on other 4xx, usage optional | Existing provider mock and real HTTP tests pass. |
| Lean trace, protected current run, symlinks, non-run directories | Existing trace and retention tests pass; code inspection confirms lstat recursion and keep list in CLI. |
| CLI closed stdin, single JSON, config failures | Existing tests pass. New tests found invalid expectation returned select_tab and invalid provider settings returned internal_error; fixed. --pretty is an explicit multiline exception. |
| CLI port from options JSON | New regression found options.port ignored, causing fixed-port collisions even when the caller requested port zero. Fixed precedence to flags, environment, then options. |
| Long-poll wakes, early screenshot resolves, stale lease survives | Existing companion/worker tests and headless extension smoke pass. |
| Page risks only buttons, child tabs, passwords, javascript links | New real headless DOM regressions pass. Child links were offered despite being blocked. Base target blank bypassed blocking. Both fixed. |
| Text capped at 8000, semantic revision | New headless test exposed truncated text omitted from semantic signature; fixed. Cap and textTruncated pass. |
| Legal select/button actions accepted by page | Disabled options/optgroups were offered; disabled optgroup selection was not blocked. Metadata/filter/dispatch fixed. Standalone type=submit input with reversible risk was needlessly dropped by runtime; fixed. |
| Cancellation partial event, callback failures | Existing runtime tests pass; interrupted execution remains in the trace. |
| SDK time budget in a standalone process | New subprocess regression found AbortSignal.timeout's unref'ed timer let Node exit 13 without delivering the promised result. Fixed with a referenced session timeout cleared on close and observe completion. |
| Action-aware settle, one injection/document, JPEG encoder | Worker tests and smoke pass. Additional assertTab at capture is justified because captureVisibleTab uses the currently active tab. |
| Provider metadata, types, paths, retention defaults | Existing tests and inspection pass; added types for linkTarget and disabled options. |

## Intentional departures

HTTP long-poll instead of WebSocket and Pause ending the run remain Phase 2/3 work, as documented.
SDK results contain in-memory screenshot objects until writeRun externalizes them; serialized CLI results use paths. Reasonable lifecycle split, but not literally identical result objects.
--pretty emits multiline JSON by explicit opt-in. Reasonable diagnostic option; consumers must omit it for JSON-line framing.
