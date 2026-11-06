# FAI Agent direct vs Playwright-style accessibility snapshot

Generated: 2026-11-06T16:16:04.058Z

Captured: 2026-11-06T14:10:31.268Z through 2026-11-06T14:14:51.178Z

**Token columns:** exact tokenizer counts where available; chars/4 is a rough baseline. Claude Sonnet 5.5 and Opus 5.5 are **not measured in this run** because current Claude models have no official offline tokenizer.

## Method

- 12 public, logged-out pages captured as self-contained static copies on the dates above, then served from `bench/tokens/pages/` on loopback. Scripts were stripped, available CSS was inlined, and images were replaced with same-size/same-alt placeholders. Captured pages and raw strings are not committed.
- One headless Chromium, one page at a time, 1280 × 900 viewport, `en-US`; each page uses a fresh browser context, daemon, MCP server and temporary FAI home.
- FAI path: real stdio MCP server → real daemon/runtime → test hub → `PageBridge` → real `extension/page.js` in Chromium. Agent direct, interactive level, no screenshots and no provider.
- The opening task is `Read the page and summarize its main content.`. The act is `scroll down`. The separate follow-up is one `fai_browser_observe` with `focus: "main content details"` and `digestChars: 6000`, after the act.
- FAI results are text-only. The primary FAI measurement is the exact MCP text block, which is also the Codex/reproduced Claude Code/legacy OpenCode model-visible fallback. OpenCode 2 whole-result JSON is reported separately. MCP/JSON-RPC envelopes, tool schemas and host instructions are not counted; see `docs/dev/mcp-result-shape.md`.
- Raw snapshots are exact `page.locator('body').ariaSnapshot({ mode: 'ai' })` strings at the same before/after-act DOM states. Snapshot MCP columns add the explicit `browser_snapshot` Page/Snapshot YAML wrapper and local URL/title. This counts full snapshot strings rather than a current default host envelope: Playwright MCP 0.0.83 links automatic snapshots as files, and a host decides when to read them. The separate native task benchmark counts actual MCP text plus issued snapshot artifacts actually read.
- OpenAI counts use `js-tiktoken` with `o200k_base`, the closest public encoding for current Sol/Astra-era GPT models. Kimi counts use Moonshot's published Kimi K2 `tiktoken.model` and official pattern, with no chat template or BOS/EOS. These count the same strings, not provider-side envelopes.
- Versions: FAI Browser 0.3.1, Node v24.22.2, playwright-core 1.63.0, Chromium 156.0.8078.79, MCP SDK 1.32.0.

Ratios are snapshot ÷ FAI using medians across pages; “smaller” is the corresponding FAI token reduction. The ratio of medians is not the median of per-page ratios; the latter is retained in JSON.

## Medians and ratios

| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Snapshot after act | Ratio / reduction |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Chars / 4 | 1059 | 11654 | 11.00× / 90.9% smaller | 1069 | 11654 | 10.90× / 90.8% smaller | 1743 | 11654 | 6.69× / 85.0% smaller |
| OpenAI o200k_base | 1147 | 11786.5 | 10.28× / 90.3% smaller | 1167.5 | 11786.5 | 10.10× / 90.1% smaller | 1827.5 | 11786.5 | 6.45× / 84.5% smaller |
| Kimi K2 tiktoken | 1152.5 | 11780 | 10.22× / 90.2% smaller | 1172 | 11780 | 10.05× / 90.1% smaller | 1838 | 11780 | 6.41× / 84.4% smaller |
| Claude Sonnet 5.5 | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| Claude Opus 5.5 | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |

### OpenCode 2 whole-result host view

| Tokenizer | FAI open | Snapshot open | Ratio / reduction | FAI act | Snapshot after act | Ratio / reduction | FAI follow-up | Ratio / reduction |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Chars / 4 | 1123 | 11654 | 10.38× / 90.4% smaller | 1127 | 11654 | 10.34× / 90.3% smaller | 1812 | 6.43× / 84.5% smaller |
| OpenAI o200k_base | 1177.5 | 11786.5 | 10.01× / 90.0% smaller | 1197 | 11786.5 | 9.85× / 89.8% smaller | 1875.5 | 6.28× / 84.1% smaller |
| Kimi K2 tiktoken | 1179 | 11780 | 9.99× / 90.0% smaller | 1197 | 11780 | 9.84× / 89.8% smaller | 1880 | 6.27× / 84.0% smaller |
| Claude Sonnet 5.5 | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| Claude Opus 5.5 | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |

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
| wikipedia | 890 | 964 | 1942 | 35759 | 35759 |
| github-repository | 1525 | 1712 | 2747 | 17721 | 17721 |
| mdn-aria | 1236 | 1266 | 1939 | 11280 | 11280 |
| python-asyncio | 1477 | 1478 | 2028 | 5322 | 5322 |
| hacker-news | 1040 | 1086 | 1041 | 12293 | 12293 |
| bbc-article | 1264 | 1240 | 1492 | 8334 | 8334 |
| shop-product | 1702 | 1700 | 2929 | 20034 | 20034 |
| shop-category | 1787 | 1787 | 2651 | 88491 | 88491 |
| stackoverflow-question | 644 | 660 | 1716 | 40733 | 40733 |
| package-registry | 1058 | 1095 | 1318 | 6778 | 6778 |
| weather-forecast | 639 | 850 | 1261 | 6042 | 6042 |
| government-info | 978 | 1010 | 1101 | 2922 | 2922 |

## Per page: Kimi K2 tiktoken

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | 894 | 968 | 1952 | 36415 | 36415 |
| github-repository | 1528 | 1706 | 2747 | 17513 | 17513 |
| mdn-aria | 1238 | 1268 | 1950 | 11272 | 11272 |
| python-asyncio | 1530 | 1516 | 2089 | 5384 | 5384 |
| hacker-news | 1035 | 1087 | 1042 | 12288 | 12288 |
| bbc-article | 1265 | 1239 | 1494 | 8416 | 8416 |
| shop-product | 1735 | 1733 | 2993 | 20026 | 20026 |
| shop-category | 1810 | 1808 | 2685 | 87361 | 87361 |
| stackoverflow-question | 650 | 666 | 1726 | 40773 | 40773 |
| package-registry | 1067 | 1105 | 1333 | 6717 | 6717 |
| weather-forecast | 654 | 864 | 1285 | 6099 | 6099 |
| government-info | 982 | 1013 | 1102 | 2927 | 2927 |

## Per page: Claude Sonnet 5.5

**Pending owner run.**

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| github-repository | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| mdn-aria | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| python-asyncio | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| hacker-news | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| bbc-article | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| shop-product | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| shop-category | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| stackoverflow-question | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| package-registry | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| weather-forecast | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| government-info | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |

## Per page: Claude Opus 5.5

**Pending owner run.**

| Page | FAI open | FAI act | FAI follow-up | Snapshot open | Snapshot after act |
|---|---:|---:|---:|---:|---:|
| wikipedia | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| github-repository | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| mdn-aria | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| python-asyncio | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| hacker-news | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| bbc-article | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| shop-product | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| shop-category | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| stackoverflow-question | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| package-registry | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| weather-forecast | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |
| government-info | not measured in this run | not measured in this run | not measured in this run | not measured in this run | not measured in this run |

## Suggested website claim

Across 12 captured public pages, FAI Agent direct’s opening result used **90.3% fewer o200k_base tokens** than a full Playwright MCP-style accessibility snapshot (median 1147 vs 11786.5 tokens); this compares output size, not task success or accuracy.

## Caveats

- This approximates Playwright MCP with Playwright's own AI ARIA snapshot engine plus the public MCP response wrapper. It does not run Microsoft Playwright MCP itself, so version-specific formatting and ref allocation can differ. No default truncation is applied.
- Claude counts were not measured in this run. The optional owner-only `bench/tokens/count-anthropic.mjs` uses Anthropic's count_tokens endpoint and its minimal one-user-message envelope. The old `@anthropic-ai/tokenizer` is not used as a substitute for current Claude models.
- FAI is task-ranked, not a complete accessibility tree. Defaults cap the digest at about 1,500 characters / 25 blocks and list at most 80 control actions at interactive level (40 at read-only/reversible; page actions are additional). The page script itself caps observed controls at 100. The 6,000-character follow-up is one deliberate read-more call, not a bound on total conversation cost.
- A snapshot includes accessibility roles, names, states and tree relationships that FAI may omit. FAI instead includes trusted status/next-step metadata and task-ranked offered actions. The outputs are not feature-equivalent. **Success and accuracy are not measured here.**
- These are static captured copies, not live-site runs; dynamic behavior, personalization, regional variants, consent states and later page changes are outside the measurement. Medians aggregate unlike pages and should not be generalized to the web. Public JSON/Markdown contain counts and sizes only, no captured page text.
- Random local ports and generated ids remain in the measured payloads, so counts can vary slightly between runs.

Reproduce by running `node bench/tokens/capture.mjs`, then `npm run bench:tokens:real` (install locked dependencies first). Captures, tokenizer cache and raw measurement strings stay local.
