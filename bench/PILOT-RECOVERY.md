# Resumable live pilot attempts

This wrapper is for the reviewed Astra/OpenAI, medium-effort, 600-second browser pilots. Run it outside the restricted coding sandbox with normal Codex authentication. It does not change the browser extension or daemon, grant permission automatically, or enable other providers.

Create a **new attempt** from an existing pilot's saved task, first open arguments and call limit:

```sh
node scripts/resumable-pilot.mjs --new-from /tmp/fai-airbnb-pilot/run-EXAMPLE --dry-run
node scripts/resumable-pilot.mjs --resume /tmp/fai-resumable-pilot/session-PRINTED
```

The source directory must contain the original `plan.json`, `prompt.txt`, and `events.jsonl` with an open call. A dry-run imports and validates configuration without contacting a provider or browser. The earlier attempt remains separately identified; it is neither a resumed Codex thread nor silently omitted from retry accounting. A source guard refusal cannot be retried through this command.

Ctrl-C stops the wrapper's own host process group and saves its events and checkpoint. After restoring the approved browser tab and clicking Resume where requested, run the same `--resume` command. Each segment starts a fresh ephemeral host. It checks only the saved request and observes before choosing another action; it must never repeat an interrupted action blindly. An action interrupted in flight may already have executed.

MCP transport shutdown releases requests owned by that transport, even when the agent never called a release tool. If that ended the request, explicitly authorize a new request with the same task and scope:

```sh
node scripts/resumable-pilot.mjs --resume /tmp/fai-resumable-pilot/session-PRINTED --fresh-approval
```

The user must approve that new request normally. It does not silently adopt another tab, expand origins, change the level or retry a risk refusal. Risk refusals, finished tasks and exhausted budgets are terminal for this wrapper. If a hard crash prevented a final checkpoint, execution duration and action outcome are unknown, so the wrapper refuses to extend the budget.

Private session directories retain every segment's raw events, answer, stderr, arrival timestamps and immutable task manifest. The execution budget is 600 seconds across segments; startup, tools and within-segment human waits count. Between-segment gaps are recorded separately, not labelled as exact human or approval time. Missing/interrupted usage makes aggregate token totals unknown; reported partial counters remain in the segment evidence. Requested and reported models are distinct. Costs and task success remain unknown pending independent review. Model instructions govern tool-call limits and task scope; browser approval and native guardrails remain the enforcement boundary.

Offline checks: `node --test test/pilot-recovery.test.js`. These run a synthetic child process and make no provider or browser calls.
