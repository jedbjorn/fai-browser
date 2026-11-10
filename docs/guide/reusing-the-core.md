# Reusing the core in another project

FAI Browser is written so its safety-critical parts are plain ES modules with no dependencies and no I/O: the guardrails, the
secret redactor, origin matching, the page digest and the verification logic. You can embed them in your own agent, browser
tool or test harness. This page maps the module boundaries and shows how to use the leaf modules today, from a checkout of
this repository. Separate npm packages are planned; the proposal is in [docs/design/package-split.md](../design/package-split.md).

## Module map

The Imports column shows `import` relationships inside `src/`. Leaf modules import nothing.

| Layer | Modules | Imports | What it gives you |
|---|---|---|---|
| **Secrets** | `secrets.js` | none | `findSecrets`, `redactText`, `redactUrl`, `secretPage`, `scrubString`, `scrubSecrets` (recursive over objects/arrays; MCP image blocks untouched). Deterministic; `[secret:N ...]` placeholders |
| **Guardrails** | `guardrails.js` | none | `LEVELS`, `CAPABILITIES`, `capabilitiesOf`, `clampLevel`, `levelRank`, label classes (`PURCHASE`, `SUBMIT_WORDS`, `DELETE_WORDS`, `SIGN_IN_WORDS`, `PAYMENT_FIELD`, `SECRET_ACTION`, ...), `normalizeLabel`, `labelSpellings`, `forbidPattern`, `normalizeAdditions`, `guardrailPolicy` |
| **Origins** | `origins.js` (+ `psl-data.js`) | `psl-data` | Origin-entry validation, `*.example.com` domain roots by Public Suffix List, `entryCovered`, `urlCovered`, `sameSite` |
| **Page model** | `digest.js`, `relevance.js`, `oversight.js`, `expectation.js` | `digest` <- `expectation`; `relevance` -> `guardrails`, `oversight` -> `guardrails` | Task-ranked digest (`buildDigest`), action ranking and capping, consent/login/error-page detection, `verifyExpectation` |
| **Results** | `result.js`, `trace.js`, `retention.js` | `result` -> `digest`, `origins`, `oversight`, `relevance`; `trace` -> `result`, `secrets` | The receipt shapes (`directResult`, `agentResult`, `leanObserve`), trace files with redaction, pruning |
| **Bridge (hub)** | `bridge.js`, `ws.js` | `bridge` -> `guardrails`, `ws` | The server side of the extension protocol: WebSocket + long-poll hub, leases, `BridgeError`, `PINNED_EXTENSION_ID` |
| **Runtime** | `runtime.js` | digest, expectation, facts, guardrails, origins, overlay, oversight, relevance, result, secrets | `BrowserRuntime`: observe/offer/act loop over a `BrowserBridge`; `legalActions` |
| **Facts** | `facts.js` | digest | Answer candidates and aggregation across the pages an act visited |
| **Service** | `daemon.js`, `client.js`, `cli.js`, `home.js`, `settings.js`, `paths.js`, `install.js`, `native.js`, `native-host.js`, `migrate.js` | most of the above | HTTP API, SDK client, CLI, setup, state directories, native messaging |
| **MCP** | `mcp.js`, `mcp-main.js` | expectation, guardrails, home, origins, paths, result, secrets, settings | Tool schemas, server instructions, a dependency-free stdio JSON-RPC server |
| **Extension** | `extension/*` | none (browser only) | `background.js`, `page.js` (content script), `offscreen.js`, popup and approval UI, `compat.js` |

The extension cannot import from `src/`, so **three blocks are byte-copied** into it (`<secret-rules>` from `secrets.js`,
`<site-match>` from `origins.js`, the guardrail patterns and level table from `guardrails.js`) and drift-tested; see
[CONTRIBUTING.md](../../CONTRIBUTING.md#safety-boundaries-that-must-stay-intact).

## Embedding recipes

These work from a checkout (import by path). The package `exports` currently expose `src/index.js` only.

### Redact anything before it reaches a model

```js
import { scrubSecrets } from './src/secrets.js';   // @fai-browser/secrets

const safe = scrubSecrets(toolResult);             // strings anywhere in objects/arrays; same reference if nothing changed
```

Use it on tool results, logs and traces. For a single string use `scrubString(text)`; for URLs
`redactUrl`. Add your own formats by extending the `<secret-rules>` block and a fake in `fixtures/secrets/fakes.js`.
If you also run in a browser extension, copy the block as this repository does and keep a drift test.

### Gate actions by level and label

```js
import { LEVELS, clampLevel, capabilitiesOf, normalizeLabel, PURCHASE, labelSpellings } from './src/guardrails.js';

const granted = clampLevel(asked, userMax);        // never above what the user granted
const can = capabilitiesOf(granted);               // { navigate, controls, submit_safe, submit, delete, ... }
const looksLikePurchase = labelSpellings(label).some(l => PURCHASE.test(l));
```

The label classes are deliberately conservative (they refuse when unsure). Run them at **both** ends: when listing actions
and again at dispatch, as the page script does. The level table and class names are the contract; treat changes as breaking.

### Use the runtime with your own browser connection

`BrowserRuntime` talks to anything that implements the `BrowserBridge` contract (`observe()`, `execute(action,
expectedRevision, {capture})`, `capture()`, see `src/index.d.ts` and `examples/fake-demo.js`, which runs a whole task against an in-memory
bridge). Implement it over CDP, Playwright, WebDriver BiDi or your own extension, and you get the same offered-action model,
guardrails, verification and receipts. The extension protocol of this project (observation shape: URL, title, text blocks, controls
with role, label, state, bounds and risk class, a semantic revision) is documented in [ARCHITECTURE.md](../../ARCHITECTURE.md#extension-protocol).

### Embed the whole thing

Run the service and talk to it with the SDK client:

```js
import { FaiBrowserClient } from './src/client.js';
const fai = new FaiBrowserClient();                // auto-starts the daemon on 127.0.0.1:4318
```

Or speak MCP to `fai-browser-mcp`. Or reuse the extension alone with your own hub: it needs a WebSocket server that implements
the protocol in `src/bridge.js` (`PROTOCOL_VERSION`) and authenticates the pairing secret.

## Caveats before you depend on it

- Pre-1.0: module APIs can change between minor versions. Pin a version or commit.
- The guardrail and redaction rules are tuned for this project's threat model (an agent in the user's browser). Read
  [SECURITY.md](../../SECURITY.md) for what they do not cover.
- `runtime.js` is large. Prefer the leaf modules until the split.
- License: MIT. The Public Suffix List in `vendor/` is MPL-2.0: keep its notice if you copy `psl-data.js`.
