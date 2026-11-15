# Automatic cookie choices and newsletter dismissal

Status: implemented and independently reviewed, 2026-11-15.

FAI automatically chooses necessary-only cookies and dismisses unsolicited newsletter modals when a bounded mechanical rule can establish the correct control. Ambiguous popups remain visible for the agent to handle. Automatic actions use the same visibility, identity, lease, frame, and pacing checks as explicit link clicks.

## Policy and approval

The default posture for newly approved automatic handling is **reject optional cookies, keep necessary cookies; dismiss newsletter popups**. This authorizes selecting an explicit necessary-only or reject-all control. It does not claim that the website stops tracking or implements its consent choice correctly.

The approval card and modal describe this narrow behavior beside Use and Act. Their explicit approval carries a versioned nuisance policy marker into the worker session. The marker must originate in the user approval path, never an agent tool parameter. Restored sessions and legacy approvals without it perform no new automatic actions. Reapproval through the updated UI can establish it; this feature must not trigger an additional approval flow on its own.

Do not grant general `controls`, `submit`, or `consent_accept` to enable automatic handling. A private proof authorizes only the particular mechanically classified control, and the proof is checked again immediately before pressing. Existing forbidden-label and origin rules still apply. Keep manual consent classifications and API-level limits coherent; any existing legacy reject exception remains distinct from the new automatic policy.

## Cookie decision

Require a currently presented cookie or consent container, a ready control inside it, and agreement among its visible and accessible names. Use an anchored allowlist of unambiguous reject-all, reject-optional, or necessary-only phrases. Names that combine rejection with subscription, payment, account changes, acceptance of optional categories, or another action are not eligible. Controls that submit or reset forms defer to the agent even when their label says Reject all.

Prefer one unambiguous reject-all or necessary-only control. If multiple equivalent controls remain, use a documented stable ranking only when all mean the same operation; conflicting or different operations require agent handling. Vendor selectors may strengthen structural identification but never override conflicting names or visibility checks.

The first implementation handles direct choices. Settings-only banners, category toggles, selected-consent buttons, and saving preferences go to the agent because their outcome requires inspecting the selected category state. Do not automatically use Accept all, Accept selected, Agree, OK, Continue, an unexplained X, Escape, or a backdrop. Do not edit cookies, storage, styles, framework state, or call CMP APIs.

This distinction follows CMP behavior: OneTrust distinguishes RejectAll from Close, which can apply configured defaults; Cookiebot distinguishes opt-out from selected and full consent. [OneTrust operations](https://developer.onetrust.com/onetrust/docs/javascript-api), [Cookiebot controls](https://support.cookiebot.com/hc/en-us/articles/360003921454-Can-I-build-my-own-fully-customized-cookie-consent-banner-Cookiebot-Admin)

## Newsletter decision

Require a presently blocking overlay positively classified as a newsletter or email-list signup and a clearly named Close, X, or No thanks control. Modal ARIA semantics alone do not establish physical blocking. Its other names must agree with dismissal and contain no subscription, account, payment, navigation, or acceptance instruction. Exclude controls that submit or reset a form, unnamed corner-icon guesses, and generic Escape or backdrop clicks.

Preserve the modal when any relevant field contains entered or autofilled data, including CSS-hidden fields in a multi-step form, the current task concerns subscribing or interacting with that newsletter, or the agent opened it through a control interaction in the same document. Preserve embedded signup forms and ordinary page content. Do not extend this rule to login, paywall, age verification, checkout, notification, promotional, app-install, or unknown dialogs; mixed dialogs also defer.

Newsletter products can assign different behavior to buttons and outside clicks, so a modal's presence alone does not authorize its dismissal. [Klaviyo dismissal settings](https://help.klaviyo.com/hc/en-us/articles/4405381628827), [Klaviyo button actions](https://help.klaviyo.com/hc/en-us/articles/4413550187035)

## Mechanical execution

Run a single bounded stage during an authorized observe or after an explicit action, before returning its resulting page. There is no autonomous persistent watcher and no automatic work during status, screenshot, approval inspection, or point location.

The worker owns the policy, lease binding, deadline, and total action budget. The page owns candidate classification and live validation. Reuse the ordinary click dispatcher through a private internal proof; do not add an agent-callable flag that bypasses its guards.

For each attempt:

1. Observe the current approved document and classify the popup using bounded existing scans.
2. Require a ready control; do not scroll, open menus, or reveal hidden controls automatically.
3. Remember the attempted popup fingerprint before movement. Recheck the same popup, names, identity, risk, and point after movement and hover.
4. Use `explicitClick:true`, including for buttons, so the deliberate timing budget is at most 450 ms with distance-sensitive movement. Preserve worker timing in hidden task windows and trusted-input partial-dispatch safeguards.
5. Reobserve and verify whether the original popup is gone or changed. If unchanged or unavailable, stop. Never try another button on the same unchanged popup.
6. Return the final observation and fresh offer generation. Never replay an agent action selected before automatic handling changed the page.

Initial bounds: **two automatic clicks and 2,000 ms total per returned observation**, including cookie and newsletter handling together. No new attempt starts after the deadline; browser scheduling can exceed it. At most two automatic attempts per document, using bounded per-document fingerprints to prevent re-created or unchanged popups causing a loop. The limits are operational choices, not human timing measurements.

Process cookies before newsletters when both are present. Only already approved, readable frames may participate, within the same total budget and parent visibility checks. If the frame or controller cannot be validated, return it to the agent. No new origin request or tab activation is performed by this stage.

The initial implementation defers recognized same-origin child-frame newsletter modals with `frame_unsupported`; same-origin cookie controls and already-approved cross-origin frames are supported.

Unknown task intent should make newsletter dismissal conservative. Use trusted task terms supplied by the runtime, not instructions extracted from page text. A same-document explicit fill, key, select, or control action suppresses later automatic newsletter dismissal for that document; automatic nuisance actions do not set that flag themselves. Ordinary navigation to a new document starts a new budget.

## Results and fallback

Return a bounded `automatic` list with operation, outcome, reason code, and elapsed milliseconds. Labels, if included, remain untrusted and pass normal secret redaction. Private fingerprints and classification proof are never returned. Suggested operations are `cookies_necessary` and `newsletter_dismiss`; outcomes distinguish `dismissed`, `unchanged`, and `unavailable`.

Report the action actually taken, for example “selected Reject all,” separately from task verification. A disappeared banner does not establish that the user's overall task is complete. Do not treat a CMP event or stored historical consent as proof of this particular click.

When a recognized popup remains because classification, timing, authority, or validation failed, return the current ordinary actions with a concise reason. This is escalation to the agent; no extra user prompt is needed unless the agent's chosen next action requires one under the existing rules. Keep this evidence through worker, bridge, runtime, and MCP result projection.

## Implementation ownership

| Area | Responsibility |
| --- | --- |
| Page | Strict popup candidates, private dispatch proof, live guards, task-interaction suppression, fingerprints, receipts |
| Worker and approval UI | Versioned policy from explicit approval, persistence, single-flight stage and total budget, approved-frame routing, timing and cancellation |
| Runtime and results | Task terms, fresh offers, public automatic receipts, fallback actions, type declarations |
| Tests and documentation | Browser fixtures, legacy authority and security cases, integration checks, approval and agent guidance |

Keep this work separate from unrelated pending changes. Reuse the actionability and pacing implementation rather than duplicating predicates or implementing faster direct DOM clicks.

## Acceptance tests

| Case | Expected behavior |
| --- | --- |
| OneTrust or Cookiebot shaped direct reject | Exactly one paced rejection and fresh observation |
| Explicit necessary-only button | Selected without optional acceptance |
| Accept all, selected-consent, Settings only, generic Save or cookie X | No automatic selection; agent receives available controls |
| Conflicting visible and accessible names | No automatic selection |
| Cookie then newsletter | At most two independently validated paced clicks |
| Clear blocking newsletter with a safe closer | One dismissal |
| Filled, autofilled, task-related, or agent-opened newsletter | Preserved |
| Other dialog types or embedded signup form | Preserved |
| Covered, clipped, transparent, inert, moved or relabeled candidate | No press after invalidation |
| No-op or repeatedly recreated popup | No repeated automatic attempt |
| Legacy or missing policy marker | No automatic actions |
| Newly approved Use policy | Only the narrow classified operation; general controls remain unavailable |
| Stop, lease rebind, origin change, hidden-window timer failure | Stop or refuse without replay |
| Approved and unapproved iframe popup | Same parent/child checks and scope as ordinary input |
| Automatic state change before agent action | Fresh revision; old choice is not executed |
| Results and traces | Bounded redacted receipts and accurate fallback, no completion claim |

Run targeted page, worker, approval, guardrail, bridge, runtime, and result suites; then the broader required suite and independent Astra High/Sol High review. Timing checks measure deliberate plans separately from browser overhead.
