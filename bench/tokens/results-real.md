# FAI Agent direct vs Playwright-style accessibility snapshot

Generated: 2026-11-06T15:02:40.335Z

Captured: 2026-11-06T14:10:31.268Z through 2026-11-06T14:14:51.178Z

**Token columns:** exact tokenizer counts where available; chars/4 is a rough baseline. Claude Sonnet 5.5 and Opus 5.5 come from Anthropic's count_tokens endpoint (owner run), because current Claude models have no official offline tokenizer.

## Method

- 12 public, logged-out pages captured as self-contained static copies on the dates above, then served from `bench/tokens/pages/` on loopback. Scripts were stripped, available CSS was inlined, and images were replaced with same-size/same-alt placeholders. Captured pages and raw strings are not committed.
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
| Chars / 4 | 1059 | 11654 | 11.00× / 90.9% smaller | 1069 | 11654 | 10.90× / 90.8% smaller | 1743 | 11654 | 6.69× / 85.0% smaller |
| OpenAI o200k_base | 1130 | 11786.5 | 10.43× / 90.4% smaller | 1156 | 11786.5 | 10.20× / 90.2% smaller | 1819 | 11786.5 | 6.48× / 84.6% smaller |
| Kimi K2 tiktoken | 1136.5 | 11780 | 10.37× / 90.4% smaller | 1159 | 11780 | 10.16× / 90.2% smaller | 1831 | 11780 | 6.43× / 84.5% smaller |
| Claude Sonnet 5.5 | 1652 | 18067.5 | 10.94× / 90.9% smaller | 1705 | 18067.5 | 10.60× / 90.6% smaller | 2740 | 18067.5 | 6.59× / 84.8% smaller |
| Claude Opus 5.5 | 1652 | 18067.5 | 10.94× / 90.9% smaller | 1705 | 18067.5 | 10.60× / 90.6% smaller | 2740 | 18067.5 | 6.59× / 84.8% smaller |

### OpenCode 2 whole-result host view

| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Ratio / reduction |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Chars / 4 | 1123 | 11654 | 10.38× / 90.4% smaller | 1127 | 11654 | 10.34× / 90.3% smaller | 1812 | 6.43× / 84.5% smaller |
| OpenAI o200k_base | 1160 | 11786.5 | 10.16× / 90.2% smaller | 1183 | 11786.5 | 9.96× / 90.0% smaller | 1867 | 6.31× / 84.2% smaller |
| Kimi K2 tiktoken | 1163 | 11780 | 10.13× / 90.1% smaller | 1184 | 11780 | 9.95× / 89.9% smaller | 1873 | 6.29× / 84.1% smaller |
| Claude Sonnet 5.5 | 1842.5 | 18067.5 | 9.81× / 89.8% smaller | 1879.5 | 18067.5 | 9.61× / 89.6% smaller | 2919 | 6.19× / 83.8% smaller |
| Claude Opus 5.5 | 1842.5 | 18067.5 | 9.81× / 89.8% smaller | 1879.5 | 18067.5 | 9.61× / 89.6% smaller | 2919 | 6.19× / 83.8% smaller |

## Page sizes

| Page | HTML bytes | FAI open chars | Snapshot open chars | FAI act chars | Snapshot after-act chars |
|---|---:|---:|---:|---:|---:|
| [wikipedia](https://en.wikipedia.org/wiki/Web_browser) | 747289 | 3199 | 135203 | 3401 | 135203 |
| [github-repository](https://github.com/microsoft/playwright) | 4116990 | 4949 | 71291 | 5245 | 71291 |
| [mdn-aria](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA) | 149400 | 4460 | 45698 | 4513 | 45698 |
| [python-asyncio](https://docs.python.org/3/library/asyncio.html) | 67868 | 4702 | 20130 | 5050 | 20130 |
| [hacker-news](https://news.ycombinator.com/) | 42838 | 2932 | 47529 | 3043 | 47529 |
| [bbc-article](https://www.bbc.com/news/articles/cqg7xxg4jdv5o) | 133584 | 4641 | 32179 | 4463 | 32179 |
| [shop-product](https://www.amazon.com/dp/B09V3KXJPB?th=1) | 1898141 | 6090 | 72777 | 5979 | 72777 |
| [shop-category](https://www.amazon.com/s?k=headphones) | 1266229 | 6435 | 252911 | 6321 | 252911 |
| [stackoverflow-question](https://stackprinter.appspot.com/export?question=11227809&service=stackoverflow&language=en&hideAnswers=false&showAll=true&width=700) | 267680 | 2267 | 162300 | 2308 | 162300 |
| [package-registry](https://pypi.org/project/playwright/) | 610241 | 3489 | 25367 | 3590 | 25367 |
| [weather-forecast](https://forecast.weather.gov/MapClick.php?lat=40.71427&lon=-74.00597) | 324965 | 2056 | 21936 | 2798 | 21936 |
| [government-info](https://www.usa.gov/disability-services) | 898736 | 4009 | 11398 | 4085 | 11398 |

## Per page: Chars / 4

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | 800 | 851 | 2022 | 33801 | 33801 |
| github-repository | 1238 | 1312 | 2399 | 17823 | 17823 |
| mdn-aria | 1115 | 1129 | 1940 | 11425 | 11425 |
| python-asyncio | 1176 | 1263 | 1785 | 5033 | 5033 |
| hacker-news | 733 | 761 | 734 | 11883 | 11883 |
| bbc-article | 1161 | 1116 | 1434 | 8045 | 8045 |
| shop-product | 1523 | 1495 | 2719 | 18195 | 18195 |
| shop-category | 1609 | 1581 | 2425 | 63228 | 63228 |
| stackoverflow-question | 567 | 577 | 1701 | 40575 | 40575 |
| package-registry | 873 | 898 | 1140 | 6342 | 6342 |
| weather-forecast | 514 | 700 | 1102 | 5484 | 5484 |
| government-info | 1003 | 1022 | 1168 | 2850 | 2850 |

## Per page: OpenAI o200k_base

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | 883 | 966 | 1935 | 35759 | 35759 |
| github-repository | 1531 | 1720 | 2753 | 17721 | 17721 |
| mdn-aria | 1222 | 1255 | 1925 | 11280 | 11280 |
| python-asyncio | 1486 | 1488 | 2037 | 5322 | 5322 |
| hacker-news | 1038 | 1082 | 1039 | 12293 | 12293 |
| bbc-article | 1255 | 1230 | 1483 | 8334 | 8334 |
| shop-product | 1684 | 1684 | 2911 | 20034 | 20034 |
| shop-category | 1797 | 1794 | 2661 | 88491 | 88491 |
| stackoverflow-question | 641 | 658 | 1713 | 40733 | 40733 |
| package-registry | 1037 | 1077 | 1297 | 6778 | 6778 |
| weather-forecast | 641 | 852 | 1263 | 6042 | 6042 |
| government-info | 964 | 995 | 1087 | 2922 | 2922 |

## Per page: Kimi K2 tiktoken

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | 889 | 973 | 1947 | 36415 | 36415 |
| github-repository | 1534 | 1716 | 2753 | 17513 | 17513 |
| mdn-aria | 1227 | 1260 | 1939 | 11272 | 11272 |
| python-asyncio | 1537 | 1524 | 2096 | 5384 | 5384 |
| hacker-news | 1033 | 1083 | 1040 | 12288 | 12288 |
| bbc-article | 1258 | 1232 | 1487 | 8416 | 8416 |
| shop-product | 1717 | 1716 | 2975 | 20026 | 20026 |
| shop-category | 1817 | 1813 | 2692 | 87361 | 87361 |
| stackoverflow-question | 647 | 664 | 1723 | 40773 | 40773 |
| package-registry | 1046 | 1086 | 1312 | 6717 | 6717 |
| weather-forecast | 655 | 865 | 1286 | 6099 | 6099 |
| government-info | 968 | 998 | 1088 | 2927 | 2927 |

## Per page: Claude Sonnet 5.5

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | 1292 | 1400 | 2915 | 56267 | 56267 |
| github-repository | 2147 | 2482 | 4184 | 27354 | 27354 |
| mdn-aria | 1774 | 1811 | 2900 | 18014 | 18014 |
| python-asyncio | 2125 | 2130 | 3025 | 8094 | 8094 |
| hacker-news | 1409 | 1479 | 1426 | 18121 | 18121 |
| bbc-article | 1850 | 1809 | 2221 | 12859 | 12859 |
| shop-product | 2398 | 2382 | 4496 | 31302 | 31302 |
| shop-category | 2561 | 2535 | 4126 | 133318 | 133318 |
| stackoverflow-question | 957 | 964 | 2580 | 60440 | 60440 |
| package-registry | 1530 | 1601 | 1995 | 9796 | 9796 |
| weather-forecast | 1003 | 1335 | 2091 | 9435 | 9435 |
| government-info | 1409 | 1454 | 1598 | 4382 | 4382 |

## Per page: Claude Opus 5.5

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | 1292 | 1400 | 2915 | 56267 | 56267 |
| github-repository | 2147 | 2482 | 4184 | 27354 | 27354 |
| mdn-aria | 1774 | 1811 | 2900 | 18014 | 18014 |
| python-asyncio | 2125 | 2130 | 3025 | 8094 | 8094 |
| hacker-news | 1409 | 1479 | 1426 | 18121 | 18121 |
| bbc-article | 1850 | 1809 | 2221 | 12859 | 12859 |
| shop-product | 2398 | 2382 | 4496 | 31302 | 31302 |
| shop-category | 2561 | 2535 | 4126 | 133318 | 133318 |
| stackoverflow-question | 957 | 964 | 2580 | 60440 | 60440 |
| package-registry | 1530 | 1601 | 1995 | 9796 | 9796 |
| weather-forecast | 1003 | 1335 | 2091 | 9435 | 9435 |
| government-info | 1409 | 1454 | 1598 | 4382 | 4382 |

## Suggested website claim

Across 12 captured public pages, FAI Agent direct’s opening result used **90.4% fewer o200k_base tokens** than a full Playwright MCP-style accessibility snapshot (median 1130 vs 11786.5 tokens); this compares output size, not task success or accuracy.

## Caveats

- This approximates Playwright MCP with Playwright's own AI ARIA snapshot engine plus the public MCP response wrapper. It does not run Microsoft Playwright MCP itself, so version-specific formatting and ref allocation can differ. No default truncation is applied.
- Claude counts come from the owner-run `bench/tokens/count-anthropic.mjs` (Anthropic count_tokens endpoint) and include that endpoint's minimal one-user-message envelope, a few tokens per string. The old `@anthropic-ai/tokenizer` is not used as a substitute for current Claude models.
- FAI is task-ranked, not a complete accessibility tree. Defaults cap the digest at about 1,500 characters / 25 blocks and list at most 80 control actions at interactive level (40 at read-only/reversible; page actions are additional). The page script itself caps observed controls at 100. The 6,000-character follow-up is one deliberate read-more call, not a bound on total conversation cost.
- A snapshot includes accessibility roles, names, states and tree relationships that FAI may omit. FAI instead includes trusted status/next-step metadata and task-ranked offered actions. The outputs are not feature-equivalent. **Success and accuracy are not measured here.**
- These are static captured copies, not live-site runs; dynamic behavior, personalization, regional variants, consent states and later page changes are outside the measurement. Medians aggregate unlike pages and should not be generalized to the web. Public JSON/Markdown contain counts and sizes only, no captured page text.
- Random local ports and generated ids remain in the measured payloads, so counts can vary slightly between runs.

Reproduce by running `node bench/tokens/capture.mjs`, then `npm run bench:tokens:real` (install locked dependencies first). Captures, tokenizer cache and raw measurement strings stay local.
