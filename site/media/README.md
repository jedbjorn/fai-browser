# Site media and benchmark data

The PNG and MP4 files are copies of the genuine captures in `docs/media/`. Do not replace them
with illustrative product screenshots or footage of personal browser sessions.

| File | Use | Provenance |
|---|---|---|
| `demo.mp4` | Product demo | Edited, silent presentation of a genuine Firefox 159 development-build session on local fixtures; scripted MCP calls and automated approval clicks |
| `approval-card.png` | Hero tab request | Unmodified development-add-on UI capture; local test origin and fake task |
| `approve-once.png` | Demo poster and payment feature | Unmodified development-add-on UI capture; fake local shop and $142.80 fixture total |
| `secret-placeholders.png` | Redaction feature | Verbatim MCP digest excerpt using repository fixture secrets |
| `redacted-screenshot.png` | Available redaction capture | Firefox page beside the actual FAI-redacted MCP image; fake fixture data |
| `firefox-launcher.png` | Available launcher capture | Actual signed 0.3.0 add-on in the dedicated FAI profile |
| `social-preview.png` | Open Graph and Twitter card | Project social graphic, 1280 × 640 |

The full capture record, limitations and media hashes are in `docs/guide/demo.md` and
`docs/media/manifest.json`. Dark site themes do not recolour the light product captures.

## `benchmark-data.json`

The Agent-direct task chart reads this same-origin JSON file. Its checked-in state is `complete`,
with four common workflows from the final 0.3.2 native run. Two separate safety scenarios are
excluded from performance aggregates. The HTML also contains the measured SVG and text table,
so results remain available without JavaScript or if the JSON fetch fails. Update that static
snapshot alongside the JSON when publishing new measurements. Only complete, validated results
may be published; the Pages workflow rejects pending data.

Top-level fields:

- `schemaVersion`: must be `1`.
- `status`: `"pending"` or `"complete"`; invalid or incomplete data also leaves the chart pending.
- `label`: methodology label shown below the chart. Describe the sample size and excluded safety scenarios.
- `run.model`: host and effort label, currently `"Sol 6.1 medium"`.
- `run.protocol`: orchestration label, currently `"Fresh native agents via MCP relay"`; this is not
  a Codex CLI run.
- `run.taskCount`: positive integer, currently `4`.
- `run.repeats`: positive integer, currently `1`.
- `run.environment`: human-readable environment description.
- `run.measuredAt`: completion date, ISO `YYYY-MM-DD` recommended; `null` while pending.
- `run.source`: repository path to the final result directory or summary; `null` while pending.

`metrics` must contain exactly these four objects, in any order. The SVG view box height is derived
from the rendered metric count, so removing a metric does not leave an empty row.

| `id` | Required content | Unit | Expected aggregation |
|---|---|---|---|
| `passes` | Independent verified passes for each system | `tasks` | `total` |
| `calls` | Actual MCP calls on tasks where both systems succeeded | `calls` | `median` |
| `artifacts` | Issued snapshot artifacts actually read by the driver on matched successes | `reads` | `median` |
| `tokens` | Observed MCP text tokens, including those snapshots actually read, on matched successes | `tokens` | `median` |

Each metric has `label`, `unit`, `aggregation`, and two points, `a` (Playwright MCP) and `b` (FAI
Agent direct). Each point requires a finite, non-negative numeric `value`. An optional string
`display` controls the visible value; otherwise the site formats the number and unit. Passes are
displayed as `passes / taskCount`.

For `calls`, `artifacts` and `tokens`, `matchedTasks` is required: an integer from 1 through
`taskCount`, identifying the number of matched successful tasks used. `scaleMax` is optional. If
present it must be a positive number at least as large as both values; otherwise the larger measured
value is the pair's maximum. Both bars in every pair start at the same zero and use the same scale.
A measured zero is valid and produces a zero-width bar, not a fabricated placeholder.

Snapshot artifact reads are separate from MCP calls. Observed text tokens use `o200k_base` and cover
returned MCP text plus issued snapshots actually read; they exclude model prompts, tool schemas,
reasoning and billed input. Wall time includes native orchestration and is not charted. Cost, billed
model tokens and model-request counts are unavailable and must not be inferred.

Do not copy partial benchmark output into this file. Do not put the older Jev autopilot task numbers
in this Agent-direct chart. The separate twelve-page opening-token evidence is hard-coded from the
fresh release 0.3.1 `bench/tokens/results-real-0.3.1` corpus: medians of 1,147 versus 11,786.5, a
90.27% reduction displayed as 90.3%. It measures output size, not task success. The demo retains its
historical release 0.3.0 chart with the earlier 1,130 median.
