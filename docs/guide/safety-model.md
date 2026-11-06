# Safety model

FAI Browser assumes **you** are trusted, your **agent** is semi-trusted (it follows you but can be misled), and **page
content** is untrusted. The goal is that the worst a misled agent can do is bounded by what you approved. This page
explains the layers; [SECURITY.md](../../SECURITY.md) lists what is *not* protected. Rule details live in
[REFERENCE.md](../REFERENCE.md#guardrails).

## 1. One tab, approved per request

The agent cannot pick a tab. It asks (`fai_browser_open`) with exact **origins**, a one-line **reason** and a **level**. You
see the request (site, level, reason, marked as the agent's words) and approve it with a click in the extension. That binds
**one tab** to **that request**; nothing the agent sends can select another tab or window, and browser-internal pages are
never used.

- Origins are exact (`https://app.example.com`). For a task that spans subdomains of one site the agent may ask for a
  **domain root** (`https://*.example.com`); you see it as "all of example.com", and Chrome asks you to allow the site too.
  Matching follows the Public Suffix List.
- Leaving the approved origins pauses the session. Redirects to other sites do not carry the grant.
- There is one active lease at a time. **Pause** and **Stop** are in the popup; a per-request call and time budget ends runaway agents (50 calls / 20 minutes by default, your setting is the ceiling).

## 2. Levels you choose

The agent asks for a level; you grant the same or lower. The run is **clamped** to your choice, the result reports
`granted`, and nothing the agent, a page or a config file sends can raise it.

| Level (UI) | API `mode` | Adds |
|---|---|---|
| Read | `read-only` | same-origin links, scroll, wait, allowed URLs |
| Use | `reversible` | + buttons, selects, fills of values the user supplied |
| Use | `interactive` | + search, filter, sort and paging submits (only on pages without password or payment fields) |
| Act | `full` | + save, send, submit, delete, accept a cookie dialog that has no reject button |
| Test site | `testing` | + sign-in, purchase, payment fields; only for exact origins you listed under Advanced, Test sites; the tab card reads "TEST SITE, no guardrails" |

Cookie dialogs are rejected first at every level; below Act an accept-only dialog goes to you.

## 3. Guardrails run three times

Every offered action and every dispatched click is checked by label and field rules in three places: the **service**
(`src/guardrails.js`), the extension **worker**, and the **page script** (`extension/page.js`, byte-copied rules, drift-tested).
Labels are normalized (case, spacing and spelling variants) and classified: purchase, commit, submit,
delete, sign-in, secret action, payment field. A control the level does not allow is not offered; a control that slips
through is refused again at dispatch.

You can **tighten** with `policy: {"forbid": ["Upgrade"]}` per request or in `config.json`: it only adds refused labels,
at every level including Test site. Nothing removes one.

## 4. The Approve gate

Some actions are worth doing but not without you: purchases, deletions, credential actions (generate, reveal or copy a key,
password, token), secret handle uses, and submits above the granted level. They are offered marked `needsApproval`
("asks the user"), and acting on one opens a window you must answer. Single-use, bound to tab, page revision, control and label
hash, 60 seconds, no "always allow". [approvals.md](approvals.md).

Never approvable, whatever you click: sign-in or password/card fields outside Test site, a label you forbade, a page outside the
approved origins, anything at Read.

## 5. Secrets are redacted

Values that look like credentials are replaced with `[secret:N ...]` in everything the agent receives: text, labels, URLs,
screenshots, traces and logs. [secret-redaction.md](secret-redaction.md).

## 6. Page text is data

Tool results separate **trusted** fields (`status`, `next`, `verification`, `granted`, `needs`) from page-derived text, which sits
under an "untrusted page text" heading. An injection guard limits what runs on pages that address an agent, and the agent's
instructions say never to follow instructions from a page. This reduces risk; it cannot remove it. See below.

## 7. Outcomes are verified, not claimed

A task is done only when `status` is `completed` and `verification.passed` is true: the agent's last action carried an
**expectation** (`{"urlIncludes": "/orders/confirmed"}`, `{"textIncludes": "Order saved"}`) and the real, settled page matched.
Expectations are checked against redacted text, so they cannot be used to guess a secret.

## 8. Local by construction

The service listens on `127.0.0.1`. Clients use a bearer token, the extension a pairing secret handed out by the native
host to the FAI extension only. In the default mode FAI makes **no** network calls of its own. Traces stay local and are pruned (50 runs, 500 MB, 7 days).

## What is and is not protected

| Protected | Not protected |
|---|---|
| Tab choice, origins, level, risky clicks | Prompt injection **within** a level you granted: a malicious page can steer the agent to do Use-level things on that tab |
| Known secrets in text, URLs and screenshots | Secrets with no rule (short passwords in prose, text in canvases or images, cross-origin frames) |
| What the agent holds | What your model provider sees in the redacted page; what a page does with values you let the agent type |
| The pairing secret | A compromised OS account or other malware running as you |

Practical advice: grant the lowest level, use a separate browser profile for agent work, approve deliberately, do not stay
signed in to accounts the task does not need, and never list a production site as a Test site.

**Which build you run.** Every build of the extension shares one extension ID (the manifest `key` pins it), and the native
messaging host trusts that ID. So the host cannot tell an official build from a modified one that carries the same ID. Run only
builds you made from source or took from the official release or store listing, and see [SECURITY.md](../../SECURITY.md) for
the full list of what is not covered.
