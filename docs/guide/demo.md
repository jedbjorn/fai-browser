# About the demo

The [81-second demo](../media/demo.mp4) and [30-second social cut](../media/demo-social.mp4) are an editorial presentation of a genuine local Firefox session. Readable terminal excerpts, captured UI stills and smooth focus transitions replace the original continuous split-screen recording. There is no audio. The GIF follows the short cut.

The underlying session used official Firefox 159, a disposable profile and a **temporary development add-on**. A scripted MCP SDK client made real calls; automation clicked the real approval UI. It was not a live model-driven session or a human clicking each approval. The video retains this disclosure throughout. It is not footage of the current signed release.

The local shop made a real loopback POST: zero fixture payments before approval and exactly one afterwards. No real purchase occurred. Both purchase and secret-fill actions returned `completed` with verification passed in the original session. The selected purchase result lines shown in the video match that recorded response. MCP call fields are excerpts, reformatted and labeled for readability; omitted request IDs are not invented.

Every key belongs to the repository's explicitly fake fixtures. The secret placeholder comes from the real returned digest. The screenshot's black boxes were applied by FAI, not drawn in the edit. Approval cards are unmodified product captures; only surrounding presentation, scale and framing change. No personal browser session, desktop, real account or production credential appears.

The standalone benchmark scene reads the recorded 12-page token corpus. Its medians are **1,130 versus 11,787 tokens**, with the latter rounded from 11,786.5 for display, approximately **90% fewer**. It compares FAI opening output with a Playwright-MCP-style accessibility snapshot using `o200k_base`. This is an offline Chromium output-size measurement, not task success, a speed comparison or a Firefox benchmark. [Method and caveats](../../bench/tokens/results-real.md).

The capture used same-document shop routes; it does not establish that the historical full-page navigation timeout was fixed. The launcher still image separately shows the original signed 0.3.0 package. Dark screenshots retain the light product UI on a labeled dark presentation background.

[Media dimensions, hashes and review record](../media/manifest.json).
