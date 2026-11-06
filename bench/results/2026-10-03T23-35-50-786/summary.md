| Task | Condition | Pass | Wall s | Tool calls | Requests | Tokens (in+out) | Priced | Cached in | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | A Playwright MCP | 2/2 | 21.3 | 4 | 5 | 57,297 | 14,740 | 48,128 | 8,980 | 190 | - |
| about-members | B-baseline FAI Browser | 2/2 | 21.8 | 3 | 4 | 78,774 | 33,696 | 51,328 | 27,166 | 280 | 1 |
| about-members | B FAI Browser | 3/3 | 15.9 | 1 | 2 | 34,816 | 8,549 | 30,208 | 4,380 | 229 | 2 |
| pricing-pro | A Playwright MCP | 2/2 | 19.9 | 4 | 5 | 57,747 | 16,115 | 47,040 | 10,531 | 176 | - |
| pricing-pro | B-baseline FAI Browser | 2/2 | 20.7 | 3 | 4 | 78,761 | 34,192 | 50,816 | 27,653 | 292 | 1 |
| pricing-pro | B FAI Browser | 3/3 | 15.2 | 1 | 2 | 34,805 | 8,443 | 30,208 | 4,407 | 199 | 2 |
| docs-auth-header | A Playwright MCP | 2/2 | 25.8 | 8 | 9 | 84,841 | 21,182 | 71,872 | 12,712 | 257 | - |
| docs-auth-header | B-baseline FAI Browser | 2/2 | 26.0 | 4 | 5 | 100,458 | 36,334 | 72,896 | 27,192 | 371 | 3 |
| docs-auth-header | B FAI Browser | 3/3 | 17.5 | 1 | 2 | 35,076 | 16,277 | 21,888 | 12,963 | 225 | 4 |
| catalog-p3-i5 | A Playwright MCP | 2/2 | 24.1 | 8 | 9 | 86,120 | 20,568 | 73,984 | 11,877 | 259 | - |
| catalog-p3-i5 | B-baseline FAI Browser | 2/2 | 21.4 | 3 | 4 | 79,961 | 24,075 | 63,360 | 16,316 | 285 | 3 |
| catalog-p3-i5 | B FAI Browser | 3/3 | 17.7 | 1 | 2 | 34,987 | 16,419 | 21,888 | 12,973 | 244 | 4 |
| slow-content | A Playwright MCP | 2/2 | 15.4 | 3 | 4 | 44,939 | 8,814 | 40,896 | 3,872 | 171 | - |
| slow-content | B-baseline FAI Browser | 2/2 | 24.5 | 4 | 5 | 89,603 | 33,132 | 64,256 | 25,007 | 340 | 3 |
| slow-content | B FAI Browser | 3/3 | 15.5 | 1 | 2 | 34,632 | 8,255 | 30,336 | 4,116 | 217 | 3 |
| settings-new-tab | A Playwright MCP | 2/2 | 22.3 | 6 | 7 | 70,369 | 25,934 | 50,368 | 19,777 | 224 | - |
| settings-new-tab | B-baseline FAI Browser | 1/1 | 29.8 | 5 | 6 | 114,535 | 34,039 | 91,520 | 22,547 | 468 | 1 |
| settings-new-tab | B FAI Browser | 3/3 | 15.8 | 1 | 2 | 34,675 | 8,237 | 30,336 | 4,123 | 209 | 2 |
| docs-lead-guide | A Playwright MCP | 1/1 | 21.2 | 6 | 7 | 70,750 | 20,998 | 56,320 | 14,196 | 234 | - |
| docs-lead-guide | B-baseline FAI Browser | 1/1 | 27.5 | 4 | 5 | 99,335 | 23,201 | 86,144 | 12,842 | 349 | 2 |
| docs-lead-guide | B FAI Browser | 3/3 | 17.9 | 1 | 2 | 35,058 | 16,233 | 21,888 | 12,849 | 240 | 3 |
| catalog-plan-price | A Playwright MCP | 1/1 | 24.7 | 8 | 9 | 86,442 | 35,539 | 57,728 | 28,451 | 263 | - |
| catalog-plan-price | B-baseline FAI Browser | 1/1 | 27.0 | 4 | 5 | 101,019 | 24,298 | 86,912 | 13,732 | 375 | 3 |
| catalog-plan-price | B FAI Browser | 3/3 | 24.1 | 2 | 3 | 48,608 | 19,178 | 34,304 | 13,943 | 361 | 5 |
| **Total** (8 tasks) | A Playwright MCP | 14/14 | 174.7 | 47 | 55 | 558,504 | 163,889 | 446,336 | 110,396 | 1,772 | |
| **Total** (8 tasks) | B-baseline FAI Browser | 13/13 | 198.7 | 30 | 38 | 742,444 | 242,967 | 567,232 | 172,454 | 2,758 | |
| **Total** (8 tasks) | B FAI Browser | 24/24 | 139.6 | 9 | 17 | 292,657 | 101,590 | 221,056 | 69,754 | 1,924 | |

A Playwright MCP / B FAI Browser over 8 shared task(s) (>1 means B FAI Browser is better): wall 1.25x, tool calls 5.22x, requests 3.24x, tokens 1.91x, priced 1.61x.

B-baseline FAI Browser / B FAI Browser over 8 shared task(s) (>1 means B FAI Browser is better): wall 1.42x, tool calls 3.28x, requests 2.21x, tokens 2.54x, priced 2.39x.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match; see summary.json for passLoose. Requests are model requests inferred from the Codex event stream. Tokens (in+out) count cached input in full; Priced = uncached x 1 + cached x 0.1 + output x 5 (assumed weights).

