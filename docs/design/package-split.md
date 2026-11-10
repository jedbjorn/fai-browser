# Package split proposal

> Note: the experimental Jev autopilot (TypeSafe provider, `fai_browser_run`, step lists, site profiles) this document describes was removed in Unreleased (after 0.6.2). Kept as history.

Status: proposal, nothing has been moved. Companion to [reusing the core](../guide/reusing-the-core.md), which has the module map.

```text
@fai-browser/secrets      secrets.js                         zero deps, the most reusable piece
@fai-browser/guardrails   guardrails.js + origins.js(+psl)    levels, label classes, origin matching
@fai-browser/core         digest, relevance, oversight,      the page model + verification + receipts:
                          expectation, result, trace,        everything an agent loop needs without a browser
                          retention, + the direct loop split out of runtime.js
@fai-browser/bridge       bridge.js, ws.js                   hub for the extension protocol (leases, WS/long-poll)
@fai-browser/extension    extension/                         built from the packages above (bundled, no copies)
@fai-browser/service      daemon, client, cli, home, settings, install, native*   (this is "fai-browser" today)
@fai-browser/mcp          mcp.js, mcp-main.js                the MCP server over the client
@fai-browser/jev          typesafe, steps, facts, domains,   experimental autopilot, optional
                          shortcuts, dates, jev loop of runtime.js
```

Dependency direction: `secrets`, `guardrails` <- `core` <- `bridge` <- `service` <- `mcp`; `jev` depends on `core` and plugs
into `service` through a driver interface (the daemon already chooses a driver at runtime). Keep every package dependency-free.
`fai-browser` (the current name) becomes a thin meta-package that depends on `service` and `mcp`, so `npx fai-browser` keeps working.
The npm name `fai-browser` and the `@fai-browser` scope are the intended names.

Order of work, cheapest first:

1. **`@fai-browser/secrets`** and **`@fai-browser/guardrails`**: already leaf modules. Add `exports`, types (`index.d.ts` already
   declares them), and publish. Replace `scripts/sync-secret-rules.mjs` and the drift tests with an extension build that inlines them.
2. **Split `runtime.js`** into the direct loop (observe, offer, legal actions, act, verify) and the Jev loop. This is
   the one real refactor; the test suite (`test/runtime-*.test.js`, `test/agent-direct.test.js`) is the safety net.
3. **`@fai-browser/core`** and **`bridge`** once the runtime split is done.
4. Move the service, MCP and Jev code last; they are applications, not libraries.
