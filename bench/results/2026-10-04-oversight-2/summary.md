| Task | Condition | Pass | Wall s | Tool calls | Requests | Tokens (in+out) | Priced | Cached in | Uncached in | Out | FAI decisions |
|---|---|---|---|---|---|---|---|---|---|---|---|
| about-members | B-baseline FAI Browser | 3/3 | 15.9 | 1 | 2 | 34,816 | 8,549 | 30,208 | 4,380 | 229 | 2 |
| about-members | B FAI Browser | 3/3 | 17.1 | 1 | 2 | 35,331 | 16,320 | 22,016 | 13,083 | 209 | 2 |
| pricing-pro | B-baseline FAI Browser | 3/3 | 15.2 | 1 | 2 | 34,805 | 8,443 | 30,208 | 4,407 | 199 | 2 |
| pricing-pro | B FAI Browser | 3/3 | 17.5 | 1 | 2 | 35,252 | 16,198 | 22,016 | 13,046 | 190 | 2 |
| docs-auth-header | B-baseline FAI Browser | 3/3 | 17.5 | 1 | 2 | 35,076 | 16,277 | 21,888 | 12,963 | 225 | 4 |
| docs-auth-header | B FAI Browser | 3/3 | 18.2 | 1 | 2 | 38,866 | 16,529 | 22,016 | 13,302 | 188 | 4 |
| catalog-p3-i5 | B-baseline FAI Browser | 3/3 | 17.7 | 1 | 2 | 34,987 | 16,419 | 21,888 | 12,973 | 244 | 4 |
| catalog-p3-i5 | B FAI Browser | 3/3 | 19.4 | 1 | 2 | 39,103 | 15,211 | 27,520 | 11,359 | 216 | 4 |
| slow-content | B-baseline FAI Browser | 3/3 | 15.5 | 1 | 2 | 34,632 | 8,255 | 30,336 | 4,116 | 217 | 3 |
| slow-content | B FAI Browser | 3/3 | 17.6 | 1 | 2 | 35,051 | 18,710 | 21,504 | 15,753 | 207 | 2 |
| settings-new-tab | B-baseline FAI Browser | 3/3 | 15.8 | 1 | 2 | 34,675 | 8,237 | 30,336 | 4,123 | 209 | 2 |
| settings-new-tab | B FAI Browser | 3/3 | 16.3 | 1 | 2 | 35,082 | 15,985 | 22,016 | 12,858 | 189 | 2 |
| docs-lead-guide | B-baseline FAI Browser | 3/3 | 17.9 | 1 | 2 | 35,058 | 16,233 | 21,888 | 12,849 | 240 | 3 |
| docs-lead-guide | B FAI Browser | 3/3 | 18.7 | 1 | 2 | 35,570 | 9,224 | 30,464 | 4,838 | 247 | 3 |
| catalog-plan-price | B-baseline FAI Browser | 3/3 | 24.1 | 2 | 3 | 48,608 | 19,178 | 34,304 | 13,943 | 361 | 5 |
| catalog-plan-price | B FAI Browser | 3/3 | 19.6 | 1 | 2 | 39,121 | 11,118 | 32,128 | 6,765 | 228 | 4 |
| **Total** (8 tasks) | B-baseline FAI Browser | 24/24 | 139.6 | 9 | 17 | 292,657 | 101,590 | 221,056 | 69,754 | 1,924 | |
| **Total** (8 tasks) | B FAI Browser | 24/24 | 144.5 | 8 | 16 | 293,376 | 119,294 | 199,680 | 91,004 | 1,674 | |

B FAI Browser receipts: 24; oversight rate 38% (9 with verdict.oversight other than none); auto-confirmed answers 15, false automation 0.

B-baseline FAI Browser / B FAI Browser over 8 shared task(s) (>1 means B FAI Browser is better): wall 0.97x, tool calls 1.13x, requests 1.06x, tokens 1.00x, priced 0.85x.

Per-cell values are medians over repeats; totals sum the medians. Pass uses exact normalized match; see summary.json for passLoose. Requests are model requests inferred from the Codex event stream. Tokens (in+out) count cached input in full; Priced = uncached x 1 + cached x 0.1 + output x 5 (assumed weights).

