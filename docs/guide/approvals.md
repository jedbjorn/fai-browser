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
  delete and cookie acceptance then run without asking again, within the approved origins and any `forbid`
  phrases. Purchases, credential actions, uploads and a committing Enter still ask. See
  [Guardrails by level](safety-model.md#guardrails-by-level).

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
tab it sits in the window's one FAI tab group and the icon shows `ON`. Every tab FAI opens or holds in that window joins that group, titled `FAI ?` while anything in it waits for you, `FAI ⏸` while paused, else `FAI`. **Pause** and **Stop** sit at the top of the popup, above every card. **Pause** pauses the tab (a run in progress ends) until you choose **Use** or **Act** to resume, **Stop** releases the tab. Domain
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
| committing Enter | An Enter the agent declares `commits: true`: sending a message, submitting an application, booking | always, whatever the settings (Test site: runs without asking) |

When the agent acts on one, the call **blocks** and a small **"FAI Browser: approve this?"** window opens with a red `!` badge. Approvals
are always this window, never only the toolbar popup. The window always opens on its own, at the top right of the browser window that holds the agent's tab, also when that window is in front, so you
do not need to open FAI Browser to see that the agent is waiting. The window shows:

- the site and tab title (from the browser, not the page),
- what kind of action it is,
- the control's label in quotes, marked as page text,
- the total the page shows, if one was detected (purchases),
- **"Agent says: ..."**, the reason the agent gave, marked as unchecked,
- for secret handles: "Paste secret:3 (openai key from platform.openai.com) into 'API key' on vercel.com", plus a warning when the secret came from another site,
- for a committing Enter: `Press Enter in "Message" on chat.example.com?` and "Agent says this commits you."

Neither button has focus, so a stray keypress cannot approve it.

- **Approve once:** the extension mints a random single-use id bound to the **tab, lease, page revision, exact control, class and a
  hash of the label**, valid 60 seconds (5 minutes when the agent had stopped waiting, see below). The click runs immediately. A new revision voids it; the page script rechecks the
  control and its label hash at dispatch. The agent cannot mint one.
- **Deny:** the act ends with `refused_action`; the agent is told to stop and tell you, not retry.
- **No answer:** the act returns `needs_user` / `approval_pending` after the wait (at most 60 s per call, so hosts that time
  a tool call out at 120 s never cut it off) and the agent ends its turn. Until you answer, the agent is **paused**: any
  other FAI call it makes does nothing and tells it to end its turn (`approval_open`). Your Approve once or Deny wakes it
  (Claude Code, Codex, OpenCode and FAI chats): it gets a fixed FAI line with the action's id, never the page's text, and
  runs the action, or stops and tells you after a Deny. An approval given this way stays usable for 5 minutes, for this
  page only: if the page changed, the agent looks again and asks again. An agent FAI cannot wake waits for you to tell it.
- **A committing Enter** asks once: every Enter the agent sends says whether it commits you (`commits`). With `true` (a
  message, a post, an application, a booking, a payment, agreeing to terms, deleting, publishing, transferring) it waits for
  your Approve once, and only that field's Enter can use it; with `false` (a search, a filter) it runs as before. The
  approval never lets an Enter run that your level refuses. An agent that says `false` for something that committed you is
  told to tell you.
- **Uploads** always ask: the card names the file, its size and the site that receives it. On a **Test site**, accepting a
  JavaScript dialog whose text names a delete or purchase asks too, with the dialog's text on the card.

There is no "always allow" and nothing is approved in advance. Time spent waiting for you does not count against the agent's time budget.

### Several things at once: one window per tab

Everything the agent waits on for one tab is asked in **one** window: its ask for more (a higher level, more sites) and
every action waiting for your approval on that tab. A typical case: an agent limited to a lower API mode (`reversible` or
`interactive`) clicks "Delete account" and asks for Act to do it. You see one window, not two:

- the title `FAI Browser: approve 2 things?` and a headline such as `Act on shop.example and click "Delete account"?`;
- each item on its own line with a tag, level first, then sites, then actions in the order asked: `LEVEL`, `SITES`,
  `DELETE`, `SUBMIT`, `PURCHASE`, `CREDENTIAL`, `COMMITS`, `SECRET`, `UPLOAD`, `DIALOG`. `DELETE`, `PURCHASE`,
  `CREDENTIAL`, `SECRET` and `COMMITS` are in the warning colour; page text is in quotes and marked `(text from the page)`;
- `Approve covers all <n> items, once each. Deny refuses all <n>.` above **Approve** and **Deny**.

**Approve** applies every item once: the level or sites, and each action with its own single-use approval, bound as
above. If you refuse the browser's site-access prompt for an added site, nothing is approved. **Deny** refuses them all:
there is no approving part of the list. If the agent adds an item while you read, the click is refused and the window
says `Updated: the agent added an item. Check the list again.` One item alone shows the usual window with **Approve
once** and **Deny**.

While the window is open the agent is paused and does nothing else; your answer wakes it once with what you decided, or,
after 5 minutes without an answer (10 at most), with the news that it expired and nothing ran. **Closing the window is
not an answer**: the approval stays waiting with the red `!` badge and a card in the popup, whose **Show approval
window** brings it back. It also comes back by itself, once, when the agent tries its next call; otherwise it expires. Only one approval window is on screen at a time; another tab's approval waits and opens after
you answer this one (`1 more approval waits on another tab.`).

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
