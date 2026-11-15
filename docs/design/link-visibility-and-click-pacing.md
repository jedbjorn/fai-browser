# Link visibility and click pacing

Status: implemented and independently reviewed, 2026-11-15.

FAI should offer a link for activation only when it is shown in the page and reachable by a pointer. A link outside the visible portion of a scroll container can be offered as **Reveal link**. Revealing scrolls to it and returns a new observation; the agent chooses whether to click afterward. Links inside closed menus or collapsed panels require an explicit action on their visible controller first.

These rules must be mechanical and consistent across action listings, direct commands, frames, synthetic input, plain input, and trusted input. Click pacing should feel quick while allowing meaningful pointer travel. Typing and wheel timing retain their existing profiles.

## Gaps reproduced before implementation

The current `rendered()` predicate in `extension/page.js` does not establish opacity, clipping, inertness, or pointer reachability. `describeControl()` marks offscreen controls `visible:true`; `src/runtime.js` offers ordinary clicks and alternate URL navigation for those controls. Dispatch scrolls and clicks without an intervening observation.

In `extension/input.js`, `aimAt()` falls back to an element's center after failed hit tests, and the synthetic click path dispatches to the element when another element owns the hit. Plain input calls `el.click()`. Isolated Chromium fixtures reproduced activation of covered, transparent, clipped, pointer-disabled, and offscreen links through both input paths.

Pointer travel currently has at most seven points with average gaps of 13 ms. Long travel therefore averages at most about 78 ms, without accounting for target width. The shared movement functions also serve typing focus and scrolling, so a global timing change would alter those working behaviors.

## Mechanical actionability contract

Use one authoritative page-side assessment for discovery and dispatch. Its result includes categorical state, a bounded reason, and internal geometry or reveal information. Input receives a validated point and a callback that reruns the same assessment immediately before pressing; it must not substitute an unchecked center or another target.

| State | Meaning | Offered action |
| --- | --- | --- |
| `ready` | Painted, enabled, non-inert, currently reachable link | Click or the existing permitted link navigation action |
| `reveal` | Candidate plausibly recoverable by scrolling its existing container chain | Reveal link only |
| `blocked` | Hidden, transparent, covered, disabled, inert, non-scrollably clipped, or unavailable | No activation action |

Apply the shared gate to pointer activation generally so a link cannot bypass it by receiving `role=button`. Existing specialized file-picker and other control semantics require regression coverage. Keep internal risk and page facts available even when activation is withheld. A candidate's DOM presence does not establish visible evidence.

The assessment must:

1. Confirm attachment, current document and lease, effective disabled/inert state, and existing guardrails.
2. Find a bounded set of painted fragments. Account for zero opacity on ancestors, CSS visibility, content visibility, closed details, and native modal blocking. `aria-hidden` alone is not a visual hiding rule.
3. Intersect fragments with the viewport and relevant overflow clips. Use inline client rects rather than only a union bounding box. For `display:contents` links, inspect bounded visible descendant or text fragments while retaining the owning link identity.
4. Find a deterministic valid point using fragment centers and bounded inset samples. A hit must belong to the target through the composed tree and must not belong to an independently actionable nested control. No valid point means no activation.
5. Check ancestor frame presentation and hit ownership as well as the child document. An iframe covered in its parent cannot authorize clicks in its child. Preserve current origin restrictions and supported frame limits.
6. Recheck the same target's identity, role, label, destination, state, and hit ownership after preparation, movement, and hover, immediately before pointerdown. Recycled virtual rows and changed destinations invalidate the decision.

CSS caveats are part of the contract: a visible descendant may override `visibility:hidden`; a descendant may restore `pointer-events:auto`; a decorative child with `pointer-events:none` need not disable its anchor. Actual visible fragments and hit ownership decide. Arbitrary masks and complex clipping may conservatively produce unavailable results when bounded checks cannot establish a usable point. Do not claim pixel-perfect visual recognition.

Geometry may vary without changing identity. Check geometry at dispatch rather than invalidating every page revision for subpixel movement. Include categorical actionability transitions in semantic revision calculation. Do not serialize private hit-test details or hidden destination URLs into agent-facing hints.

## Reveal and observation

Add an internal offered action type `reveal`, carried through the existing `fai_browser_act` action-ID interface. It consumes the current offer under the same lifecycle as other actions and is permitted wherever scrolling is permitted. It does not grant permission to open menus or activate controls.

Reveal operates on one identified candidate and its supported scroll-container chain. It may use the existing wheel behavior and browser scrolling primitives. Support vertical and horizontal nested scrollers, sticky-header correction, permitted frames, and offscreen `content-visibility:auto` containers where enough geometry exists. Never call application internals, change CSS, remove `hidden` or `inert`, or programmatically open a disclosure.

Start with at most three reposition attempts and a 1,000 ms total preparation deadline. These are product bounds, not standards requirements. Stop earlier for detachment, identity change, navigation, lease change, or no progress. Browser scheduling may exceed the deadline; no new attempt may start afterward. Keep the existing large-distance scrolling fallback bounded.

Reveal returns a fresh offer and observation even if the page's semantic content did not change. It never retains an instruction to click later. No focus, pointer press, click, form submission, or direct URL navigation is part of reveal. Pointer positioning incidental to the existing wheel implementation is permitted.

If the result is still covered or hidden, return an accurate bounded reason and current available actions. Use existing recoverable result conventions (`target_unavailable` or `stale`) where suitable. Report an unsuccessful reveal as such; it is not task completion. Never repeat an identical failed reveal internally.

`click` must no longer silently reveal a link first. If a previously ready target becomes offscreen, refuse before pressing and return the updated reveal opportunity. Internal focus clicks used by typing retain their separate behavior, but cannot bypass the final target reachability check.

## Framework behavior

Framework support derives from browser behavior rather than site-specific selectors or framework private state.

| Pattern | Required handling |
| --- | --- |
| React portals, Vue Teleport, Radix portals | Observe the approved document scope after the trigger action; do not require menu DOM ancestry under the trigger |
| Vue `v-show`, Radix `forceMount`, Headless UI mounted closed content | Mounted nodes remain unavailable while visually hidden or blocked |
| Enter and exit transitions | Require usable geometry and hit ownership; sample stability before pressing, within a bounded deadline |
| Details, disclosure navigation, tabs, hover menus | Agent chooses the visible controller as a separate offered action; reobserve afterward |
| Virtualized lists | Discover mounted content after bounded scrolling; invalidate recycled identities; never invent absent rows |
| Open shadow roots and slots | Follow composed ownership within existing traversal limits |
| Native modal and inert background | Background controls cannot receive activation |

Do not add an automatic infinite-list search. Existing scroll and observe actions remain available. An exhausted bounded scan means the requested link was not found in the inspected region, not that it is absent from the whole site.

## URL and result consistency

A reveal candidate may expose a bounded descriptive label as a discovery hint, clearly marked as needing reveal. Its destination must not appear as an actionable `href`, `other_site` navigation, `_blank` replacement, record `open`, or new-tab action before presentation eligibility is established. Hidden links must not leak back into actions through digest or record projection.

Retain private provenance separately from public projection: explicitly user-supplied URLs, URLs previously visibly disclosed, and currently unrevealed DOM-only destinations. Known DOM-only unrevealed destinations must not gain activation through a `url` or `open_tab` alias. Preserve independent user-supplied or previously visible URL authority and existing origin/guardrail checks. Compare full destinations including fragments; the current `seenKey()` normalization is insufficient for this check.

Modern extension observations establish prior-visible URL authority from ready links and the current page, not raw text that may be covered. Nontranslation, scaled, rotated, or padded frame geometry is conservatively unavailable when the native click point cannot be established.

This does not rewrite the existing policy for arbitrary unknown same-origin URLs. The implementation must distinguish that existing behavior from known unrevealed DOM destinations rather than treating any unfamiliar URL as a hidden link.

Update runtime action construction, descriptions, direct-command matching, result record projection, worker action allowlists, frame routing, and TypeScript declarations together. The new extension observations carry explicit actionability; legacy/custom bridge observations remain compatible at the runtime boundary, while the extension always enforces its live dispatch gate.

## Click pacing

Use a separate explicit-click profile. Page dispatch opts link clicks into it; internal typing focus, hover, and wheel pointer positioning retain their existing timing. Generate one plan and use it for synthetic and trusted input. Pacing must not depend on which transport happens to succeed.

Initial tuning values are product proposals, not validated universal human timing constants:

| Phase | Planned duration |
| --- | --- |
| Preparation | 15–35 ms |
| Travel | `clamp(80, 260, 40 + 45 * log2(1 + D / W))` ms, with bounded ±8 percent variation and the same final clamp |
| Hover | 20–50 ms |
| Press hold | 55–95 ms |
| Total deliberate pacing | At most 450 ms, excluding reveal, transport, application handlers, and page settling |

`D` is distance in CSS pixels from the known pointer location to the verified point. `W` is `max(8, min(fragmentWidth, fragmentHeight))` for that point's visible fragment. Skip artificial travel when the pointer is already there. A first-document pointer origin is an explicit simulation assumption, retaining the current bounded resting-point approach; it is not a claim to know the physical OS pointer position.

Use smooth acceleration and deceleration, modest curvature, an exact endpoint, and bounded time-based samples. Preparation and hover are short motor timing, not an additional page-reading delay. There is no extra pause after click. Ordinary medium-distance link clicks should generally fall around 250–450 ms of planned motion; nearby large targets can be faster.

Use elapsed-aware scheduling so slow dispatch does not add every planned interval again. Never compress overdue samples into a burst of press events, replay a partially dispatched click, or synthesize a second click after trusted input has already pressed. On interruption after pressing, release held input safely.

An authorized task tab can be hidden because its window is minimized or occluded. Preserve that supported behavior. Hidden documents must not skip click pacing: use a bounded worker-side delay facility, bound to the current lease and validated sender, when content timers would throttle. This facility must not require debugger permission, activate a tab, or change grant level. If the facility is unavailable, return a recoverable unavailable result before pressing rather than execute instantaneously. Typing and scrolling keep their current hidden-tab behavior.

## Implementation ownership

| Area | Files and responsibilities |
| --- | --- |
| Page actionability and input safety | `extension/page.js`, visibility helpers, `extension/frames.js`, final input hit validation, observation and frame tests |
| Runtime and wire behavior | `src/runtime.js`, `src/result.js`, `src/index.d.ts`, worker action allowlist, runtime and protocol tests |
| Click pacing | `extension/input.js`, bounded worker delay handling, trusted scheduling where needed, input timing and transport tests |

Coordinate shared files before edits. One implementation owner must define the assessment and callback contract used by the others. Independent review checks the final combined change against this specification and current guardrails. No implementation may replace the mechanical checks with skill prose instructing the agent to be careful.

## Acceptance and validation

The following cases must have browser-backed behavioral coverage, including both plain and realistic input where applicable:

| Case | Required result |
| --- | --- |
| Below-fold ordinary or `_blank` link | Reveal only, then fresh offer, then eligible activation |
| Nested horizontal or vertical scrolling and sticky header | Bounded reveal to a valid point, or accurate unavailable result |
| Opaque cover, zero opacity on link or ancestor, overflow clipping, pointer-disabled link | No pointerdown, click handler, or navigation through the unavailable target |
| Hidden mounted menu, closed details, collapsed panel | Controller action required before link becomes eligible |
| Portaled menu after explicit trigger | Link discovered in document scope |
| Partial visible link, wrapped inline, display contents, visible shadow descendant | Valid visible fragments remain usable |
| Decorative pointer-disabled child and visibility override | No blanket ancestor rule incorrectly disables a valid target |
| Native modal or inert subtree | Background link activation unavailable |
| Same-origin and approved cross-origin frames | Parent clipping and covering enforced as well as child checks |
| Target relabel, href mutation, recycling, cover, or detachment during motion | Refuse before pointerdown; no fallback activation |
| Failed or no-op reveal | Fresh usable offer; no hidden click or internal retry loop |
| URL aliases and records | No promotion of unrevealed destinations; independent supplied URLs still work |
| Trusted dispatch failure or partial dispatch | No duplicate synthetic press or activation |
| Hidden task document | Bounded pacing or recoverable refusal, never an instant click |

Test the pacing planner deterministically: distance and width sensitivity before clamping, exact endpoint, seeded reproducibility, bounded phase and total duration, and unchanged non-click profiles. Browser timing assertions must allow scheduler variance and distinguish planned time from elapsed time.

Replace the existing blanket click median-under-250-ms assertion only where the new profile is selected. Measure representative near, medium, and far movements with large and narrow links; report planned timing, actual input timing, reveal time, and overall act duration separately. Existing detector fixtures validate event structure, not human indistinguishability.

Run affected observation, input, frame, action, result, worker, guardrail, typing, and scrolling suites. Then run the repository's required broader checks. Release only after independent review resolves correctness issues, especially visibility bypasses, URL projection, stale target dispatch, and input replay.

## Research basis

Click actionability has multiple independent checks. Playwright includes stability and event reception as well as visibility, and its visibility definition allows zero opacity. FAI therefore needs its own shown-and-reachable predicate. [Playwright actionability](https://playwright.dev/docs/actionability)

Hit testing before activation and refusal when obscured have precedent in the WebDriver working draft. FAI additionally samples valid fragments rather than requiring only one union-box center. [WebDriver interactability](https://www.w3.org/TR/webdriver/#element-interactability)

CSS visibility APIs are partial checks; box generation, skipped content, clipping, and interaction require separate treatment. [CSSOM View](https://drafts.csswg.org/cssom-view/#dom-element-checkvisibility), [CSS containment](https://drafts.csswg.org/css-contain-2/#content-visibility), [CSS display](https://drafts.csswg.org/css-display-3/#valdef-display-contents), [CSS pointer events](https://drafts.csswg.org/css-ui/#pointer-events-control), [HTML inert subtrees](https://html.spec.whatwg.org/multipage/interaction.html#inert-subtrees)

Framework documentation establishes the mounted-hidden and portaled cases used by the acceptance fixtures. [React portals](https://react.dev/reference/react-dom/createPortal), [Vue Teleport](https://vuejs.org/guide/built-ins/teleport.html), [Vue conditional rendering](https://vuejs.org/guide/essentials/conditional.html), [Headless UI Menu](https://headlessui.com/react/menu), [Radix Dropdown Menu](https://www.radix-ui.com/primitives/docs/components/dropdown-menu), [React Aria Virtualizer](https://react-aria.adobe.com/Virtualizer)

Distance and target width motivate the proposed timing relationship; the coefficients require calibration and are not taken as universal human constants. [MacKenzie on Fitts law](https://www.yorku.ca/mack/GI92.html). Hidden-page timers can be throttled, which motivates using the worker for bounded background pacing. [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)
