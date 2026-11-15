# Approvals

FAI Browser asks you twice, at different scales: **once per request** to give the agent a tab at a level, and **once per
risky action** inside that tab. Neither can be pre-approved by the agent. Rules in full:
[REFERENCE.md: Open and approve](../REFERENCE.md#open-and-approve) and [Approve gate](../REFERENCE.md#approve-gate).

## 1. The request card

When an agent calls `fai_browser_open`, a card appears in the extension (and a `?` badge on the icon):

- **Who and what:** the agent’s name, exact origins (or "all of example.com") and reason, marked
  as the agent’s words and rendered as text.
- **Use:** one click approves reading, links, navigation, scrolling and waiting in one task tab.
- **Act:** one click approves actions and up to eight task tabs on approved sites. Save, send, submit,
  delete and cookie acceptance remain subject to the task, origin and action guardrails.

The request card, request modal, resume and invite controls use the same two buttons. There is no Read/View
choice, level dropdown, default-level setting or separate tab-access setting. Both buttons are available even
when an older agent asks for `read-only`, `reversible` or `interactive`: Act is your explicit authorization to
act. Existing grants never become Act automatically. Explicit lower API modes still cap an individual call.
For a request for `testing` on listed test origins, a separate test-only checkbox enables testing with Act;
it is never selected automatically and adds no third normal approval button.

The task page can open automatically when that setting is enabled. Opening a page grants nothing: choose
Use or Act in its request modal or the FAI Browser popup. The browser may then ask for site access.

The modal's browser permission covers the exact scheme and host across all ports; the agent remains restricted to
the approved origins and task tab(s). Access acquired for this approval is removed when no live task needs it;
existing browser grants remain. If the worker restarts while a canceled native permission prompt is still open,
late access cannot always be attributed safely and may remain until removed in browser extension settings.
Screenshots may still require the toolbar click because a host grant alone does
not grant screenshot access. The modal never asks for all-sites access to work around that limit.

"Open requested pages right away" and "Show a window when an agent asks" are settings under Advanced. While the agent holds the
tab it sits in a tab group titled `FAI` and the icon shows `ON`. **Pause** and **Stop** sit at the top of the popup, above every card. **Pause** pauses the tab (a run in progress ends) until you choose **Use** or **Act** to resume, **Stop** releases the tab. Domain
roots are remembered for 24 hours only if you turn that on.

## 2. Approve once

Some actions are offered to the agent marked `needsApproval` ("asks the user"):

| Class | Examples | Asks |
|---|---|---|
| purchase | Pay, Place order, Subscribe; a Continue/Next/Confirm inside a checkout region | at every level that offers it, while the Approve gate is on |
| delete | "Are you sure? Delete project" confirm button; cancel a subscription | at Act it runs as granted; Use never permits actions |
| secret | Create, reveal, show, copy or rotate an API key, token, password, recovery codes; the eye toggle next to a secret field | from Act, including testing |
| submit / delete above the level | A submit the granted level does not allow | legacy action grants may ask; Use requires Act approval first |
| secret handle | `fill_secret`, `copy_secret` | always, whatever the settings |

When the agent acts on one, the call **blocks** and a small **"Approve this action?"** window opens with a red `!` badge. It shows:

- the site and tab title (from the browser, not the page),
- what kind of action it is,
- the control's label in quotes, marked as page text,
- the total the page shows, if one was detected (purchases),
- **"Agent says: ..."**, the reason the agent gave, marked as unchecked,
- for secret handles: "Paste secret:3 (openai key from platform.openai.com) into 'API key' on vercel.com", plus a warning when the secret came from another site.

Neither button has focus, so a stray keypress cannot approve it.

- **Approve once:** the extension mints a random single-use id bound to the **tab, lease, page revision, exact control, class and a
  hash of the label**, valid 60 seconds. The click runs immediately. A new revision voids it; the page script rechecks the
  control and its label hash at dispatch. The agent cannot mint one.
- **Deny:** the act ends with `refused_action`; the agent is told to stop and tell you, not retry.
- **No answer:** the act returns `needs_user` / `approval_pending` after the wait (at most 60 s per call, so hosts that time
  a tool call out at 120 s never cut it off); the agent repeats the same act, and the approval stays open for 5 minutes. An
  approval you give in the meantime is picked up at once.
- **Uploads** always ask: the card names the file, its size and the site that receives it. On a **Test site**, accepting a
  JavaScript dialog whose text names a delete or purchase asks too, with the dialog's text on the card.

There is no "always allow" and nothing is approved in advance. Time spent waiting for you does not count against the agent's time budget.

### Settings

Popup, Permissions, **Approve gate** (stored in the extension, never in `config.json`, which an agent with a shell could edit):
**Ask before purchases**, **Ask before credential actions**, **Ask before actions above the level**. All on by default. Off means
the old behavior: purchases refused outside Test site, credential actions run at their level, actions above the level refused with
a level request. Secret handle uses ask whatever these say.

## 3. What is never approvable

A label you forbade (`policy`, `config.json`), a page outside the approved origins, browser-internal pages, actions at Use,
sign-in and password or card fields outside Test site, consent accepts below Act. For these the agent is refused (or handed back
to you) and no window opens.

## 4. Tips

- Read the window, not the agent's summary. The control label and total come from the page; "Agent says" is the model's claim.
- Deny anything you did not expect, then tell the agent why.
- Keep the Approve gate on. Turning it off is for test setups.
- Choose Use when you only want the agent to read and navigate; choose Act when you want it to act.
- Test site mode is for your own staging apps. The tab card says "TEST SITE, no guardrails" while it is on.

Next: [secret-redaction.md](secret-redaction.md), [safety-model.md](safety-model.md), [troubleshooting.md](troubleshooting.md).
