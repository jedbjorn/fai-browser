# FAI Agent direct vs Playwright-style accessibility snapshot

Generated: 2026-11-06T14:16:11.052Z

**Token columns:** exact tokenizer counts where available; chars/4 is a rough baseline. Claude Sonnet 5.5 and Opus 5.5 are **pending owner run** because current Claude models have no official offline tokenizer.

## Method

- 10 existing local fixture pages, served from `fixtures/` by `startStaticSite` on loopback; no live sites.
- One headless Chromium, one page at a time, 1280 × 900 viewport, `en-US`; each page uses a fresh browser context, daemon, MCP server and temporary FAI home.
- FAI path: real stdio MCP server → real daemon/runtime → test hub → `PageBridge` → real `extension/page.js` in Chromium. Agent direct, interactive level, no screenshots and no provider.
- The opening task is `Read the page and summarize its main content.`. The act is `scroll down`. The separate follow-up is one `fai_browser_observe` with `focus: "main content details"` and `digestChars: 6000`, after the act.
- FAI results are text-only. The primary FAI measurement is the exact MCP text block, which is also the Codex/reproduced Claude Code/legacy OpenCode model-visible fallback. OpenCode 2 whole-result JSON is reported separately. MCP/JSON-RPC envelopes, tool schemas and host instructions are not counted; see `docs/dev/mcp-result-shape.md`.
- Raw snapshots are exact `page.locator('body').ariaSnapshot({ mode: 'ai' })` strings at the same before/after-act DOM states. Snapshot MCP columns add the current `browser_snapshot` Page/Snapshot YAML wrapper and local URL/title. [Playwright MCP source](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/backend/response.ts) returns the full snapshot by default: there is no default snapshot truncation to model.
- OpenAI counts use `js-tiktoken` with `o200k_base`, the closest public encoding for current Sol/Astra-era GPT models. Kimi counts use Moonshot's published Kimi K2 `tiktoken.model` and official pattern, with no chat template or BOS/EOS. These count the same strings, not provider-side envelopes.
- Versions: FAI Browser 0.3.0, Node v24.22.2, playwright-core 1.63.0, Chromium 156.0.8078.79, MCP SDK 1.32.0.

Ratios are snapshot ÷ FAI using medians across pages; “smaller” is the corresponding FAI token reduction. The ratio of medians is not the median of per-page ratios; the latter is retained in JSON.

## Medians and ratios

| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Snapshot after act | Ratio / reduction |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Chars / 4 | 510.5 | 1163 | 2.28× / 56.1% smaller | 537.5 | 1163 | 2.16× / 53.8% smaller | 510.5 | 1163 | 2.28× / 56.1% smaller |
| OpenAI o200k_base | 709 | 1539.5 | 2.17× / 53.9% smaller | 752 | 1539.5 | 2.05× / 51.2% smaller | 709 | 1539.5 | 2.17× / 53.9% smaller |
| Kimi K2 tiktoken | 713.5 | 1559 | 2.19× / 54.2% smaller | 756.5 | 1559 | 2.06× / 51.5% smaller | 713.5 | 1559 | 2.19× / 54.2% smaller |
| Claude Sonnet 5.5 | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| Claude Opus 5.5 | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |

### OpenCode 2 whole-result host view

| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Ratio / reduction |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Chars / 4 | 543.5 | 1163 | 2.14× / 53.3% smaller | 570.5 | 1163 | 2.04× / 50.9% smaller | 543.5 | 2.14× / 53.3% smaller |
| OpenAI o200k_base | 730 | 1539.5 | 2.11× / 52.6% smaller | 774 | 1539.5 | 1.99× / 49.7% smaller | 730 | 2.11× / 52.6% smaller |
| Kimi K2 tiktoken | 731.5 | 1559 | 2.13× / 53.1% smaller | 774.5 | 1559 | 2.01× / 50.3% smaller | 731.5 | 2.13× / 53.1% smaller |
| Claude Sonnet 5.5 | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| Claude Opus 5.5 | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |

## Before / after: open result medians

Counts are chars/4 estimates. The baseline is the earlier merged run in this directory; its OpenCode 2 value is computed from the same raw text and structured payloads.

| Host-visible view | Before | After |
|---|---:|---:|
| Text | 481.5 | 510.5 |
| structuredContent JSON | 674 | 0 |
| Text + structuredContent | 1155.5 | 510.5 |
| Codex model view | 674 | 510.5 |
| Claude Code model view | 674 | 510.5 |
| OpenCode 2 whole-result JSON | 1192 | 543.5 |
| Legacy OpenCode text only | 481.5 | 510.5 |

## Page sizes

| Page | HTML bytes | FAI open chars | Snapshot open chars | FAI act chars | Snapshot after-act chars |
|---|---:|---:|---:|---:|---:|
| long-list | 7969 | 4055 | 9265 | 4209 | 9265 |
| search-results | 3014 | 2160 | 3325 | 2267 | 3325 |
| contact-form | 1188 | 1247 | 1823 | 1300 | 1823 |
| fare-tables | 6192 | 1697 | 19983 | 1804 | 19983 |
| workspace-settings | 2193 | 883 | 740 | 936 | 740 |
| glossary-links | 19749 | 3007 | 34619 | 3076 | 34619 |
| product-grid | 4132 | 1923 | 3738 | 2030 | 3738 |
| docs-cli | 1993 | 984 | 1948 | 1037 | 1948 |
| hotel-results | 12166 | 4894 | 15884 | 4977 | 15884 |
| flight-results | 2739 | 2648 | 5561 | 2755 | 5561 |

## Per page: Chars / 4

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| long-list | 1014 | 1053 | 1045 | 2317 | 2317 |
| search-results | 540 | 567 | 540 | 832 | 832 |
| contact-form | 312 | 325 | 312 | 456 | 456 |
| fare-tables | 425 | 451 | 425 | 4996 | 4996 |
| workspace-settings | 221 | 234 | 221 | 185 | 185 |
| glossary-links | 752 | 769 | 756 | 8655 | 8655 |
| product-grid | 481 | 508 | 481 | 935 | 935 |
| docs-cli | 246 | 260 | 246 | 487 | 487 |
| hotel-results | 1224 | 1245 | 1298 | 3971 | 3971 |
| flight-results | 662 | 689 | 662 | 1391 | 1391 |

## Per page: OpenAI o200k_base

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| long-list | 1312 | 1370 | 1350 | 2837 | 2837 |
| search-results | 611 | 653 | 611 | 995 | 995 |
| contact-form | 406 | 439 | 406 | 577 | 577 |
| fare-tables | 681 | 724 | 681 | 6005 | 6005 |
| workspace-settings | 280 | 311 | 280 | 223 | 223 |
| glossary-links | 996 | 1052 | 1026 | 11025 | 11025 |
| product-grid | 737 | 780 | 737 | 1338 | 1338 |
| docs-cli | 329 | 362 | 329 | 563 | 563 |
| hotel-results | 1641 | 1684 | 1734 | 4461 | 4461 |
| flight-results | 952 | 997 | 952 | 1741 | 1741 |

## Per page: Kimi K2 tiktoken

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| long-list | 1312 | 1370 | 1350 | 2837 | 2837 |
| search-results | 610 | 651 | 610 | 991 | 991 |
| contact-form | 412 | 444 | 412 | 581 | 581 |
| fare-tables | 685 | 728 | 685 | 6008 | 6008 |
| workspace-settings | 281 | 311 | 281 | 225 | 225 |
| glossary-links | 987 | 1053 | 1027 | 10953 | 10953 |
| product-grid | 742 | 785 | 742 | 1363 | 1363 |
| docs-cli | 329 | 362 | 329 | 562 | 562 |
| hotel-results | 1662 | 1705 | 1756 | 4491 | 4491 |
| flight-results | 971 | 1016 | 971 | 1755 | 1755 |

## Per page: Claude Sonnet 5.5

**Pending owner run.**

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| long-list | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| search-results | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| contact-form | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| fare-tables | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| workspace-settings | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| glossary-links | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| product-grid | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| docs-cli | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| hotel-results | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| flight-results | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |

## Per page: Claude Opus 5.5

**Pending owner run.**

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| long-list | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| search-results | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| contact-form | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| fare-tables | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| workspace-settings | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| glossary-links | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| product-grid | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| docs-cli | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| hotel-results | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |
| flight-results | pending owner run | pending owner run | pending owner run | pending owner run | pending owner run |

## Caveats

- This approximates Playwright MCP with Playwright's own AI ARIA snapshot engine plus the public MCP response wrapper. It does not run Microsoft Playwright MCP itself, so version-specific formatting and ref allocation can differ. No default truncation is applied.
- Claude counts await the owner-only `bench/tokens/count-anthropic.mjs` run. The old `@anthropic-ai/tokenizer` is not used as a substitute for current Claude models. After that run, Claude counts include the count_tokens endpoint's minimal one-user-message envelope.
- FAI is task-ranked, not a complete accessibility tree. Defaults cap the digest at about 1,500 characters / 25 blocks and list at most 80 control actions at interactive level (40 at read-only/reversible; page actions are additional). The page script itself caps observed controls at 100. The 6,000-character follow-up is one deliberate read-more call, not a bound on total conversation cost.
- A snapshot includes accessibility roles, names, states and tree relationships that FAI may omit. FAI instead includes trusted status/next-step metadata and task-ranked offered actions. The outputs are not feature-equivalent. **Success and accuracy are not measured here.**
- The fixture corpus is small and synthetic. `hotel-results` and `flight-results` are larger real-world-shaped local fixtures, not live captures. Medians aggregate unlike pages and should not be generalized to the web.
- Random local ports and generated ids remain in the measured payloads, so counts can vary slightly between runs.

Reproduce with `npm run bench:tokens` (install locked dependencies first). For a two-page run: `node bench/tokens/measure.mjs --pages contact-form,docs-cli --out /tmp/fai-tokens`.
