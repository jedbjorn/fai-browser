# Safety model

FAI Browser assumes **you** are trusted, your **agent** is semi-trusted (it follows you but can be misled), and **page
content** is untrusted. The goal is that the worst a misled agent can do is bounded by what you approved. This page
explains the layers; [SECURITY.md](../../SECURITY.md) lists what is *not* protected. Rule details live in
[REFERENCE.md](../REFERENCE.md#guardrails).

## 1. One tab, approved per request

The agent cannot pick a tab, and gets one you already had open only when you invite it from the popup (section 9). It asks (`fai_browser_open`) with exact **origins**, a one-line **reason** and a **level**. You
see the request (site, level, reason, marked as the agent's words) and approve it with a click in the extension. That binds
**one tab** to **that request**; nothing the agent sends can select another tab or window, and browser-internal pages are
never used.

- Origins are exact (`https://app.example.com`). For a task that spans subdomains of one site the agent may ask for a
  **domain root** (`https://*.example.com`); you see it as "all of example.com", and Chrome asks you to allow the site too.
  Matching follows the Public Suffix List.
- Leaving the approved origins pauses the session (the result names the origin the tab went to). Redirects to other
  sites do not carry the grant.
- **Frames are a boundary too.** A frame from another origin inside the approved page is read only when its own
  origin is one of the request's origins (or under an approved domain root), and only when every frame above it was
  read as well. Any other frame is never read: its text, controls and fields stay out of what the agent gets, it is
  blacked out on screenshots, and the result only names its origin (as page content) so the agent can ask you for it. An act on an approved frame's control runs in that frame
  after its origin is checked again; a frame that moved to another origin refuses it. Inside an approved frame every
  layer below applies exactly as on the page, and one page context covers the tab: a checkout page, a password field or
  a credentials page in any frame restricts every frame and the page.
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
host to the FAI extension only. In the default mode FAI makes **no** network calls of its own apart from the daily update check: one anonymous GET to
GitHub's releases API (no token, no identifiers, a generic User-Agent), or, for a private repository, `git ls-remote`
with your own git credentials; off with `FAI_UPDATE_CHECK=0`. Installing an update always takes your click in the popup
or `node src/cli.js update`; an agent's MCP calls cannot start one, while an agent with a shell can run that command
like any other CLI command (the CLI's existing trust assumption), and the updater still refuses while a tab is held,
on local changes and on anything but a fast-forward to a release. Traces stay local and are pruned (50 runs, 500 MB, 7 days).

## 9. Invites and wakes

**Invite agent** in the popup is the one way an agent gets a tab you already had open. Only your click in the
toolbar popup creates an invite: the extension's worker accepts the `invite` message only from `popup.html` itself
(not the approval window, a web page or a content script), and the service accepts it only over the extension's
paired channel; no agent, MCP or client API call can create one. The invite grants exactly the level you picked, on
that tab's exact origin (never a domain root), in one tab; every guardrail, the Approve gate and the clamping apply
unchanged. The popup sends the tab and origin it showed you, and nothing is shared if the tab changed since. Its id is
single use and expires after 10 minutes, and closing the tab or leaving its site before an agent joined revokes it.
What you type in "What should it do?" reaches the agent as your words, labelled as such; nothing from the page does.

The invited tab is yours until the agent you chose joins it, and then only that agent's. An invite for one agent
session is listed to, and joinable by, that session alone; one made for no session in particular (the copy line)
can be joined by any registered agent session, never by a bare client token. Before the join nobody can read or act
on the tab (`invite_not_joined`); after it every observe, act, run and release must come from the joining session
(`not_owner`). Other clients see only the request's id and state, never its origin or the invite id. If the invite
would end another agent's task in the same browser, the popup says so and needs a second tap.

To wake an idle agent, FAI's MCP server (the agent's own child process) writes one fixed FAI message to that agent's
own channel: Claude Code's messaging socket, `codex queue` for its own thread, or FAI's own plugin inside OpenCode. The message names the invite or
request id, the level and the tool to call, and never carries a page title, URL or page text. Each MCP server
registers with the service under a random key only it holds, so it only receives the wakes addressed to it, and it
never writes to another session's socket: the socket variables are inherited by everything Claude Code starts, so the
server uses the socket only when it is named after its own parent process (Claude Code started it directly; through a
wrapper such as npx or a shell script it fails closed to the copy line). The registry needs the client token, lists
sessions without keys or paths (the repository's folder name only). Every new connection of an MCP server's session
loop, the first one and every one after the service shut down or a connection failed, first asks the service to prove
it holds that token (an HMAC of a fresh nonce and the service's own port, in its open health answer); only then does
the token or the session key go out, so a process squatting on the port learns neither and cannot inject wakes. A
server acts on each wake once, at most 4 from one poll and 12 a minute, and never stops or starts a service of another
version from its background loop. Runs and observes of an invited tab (their results, traces and screenshots) are the
joining session's alone, also from disk after the request is gone.

**OpenCode's plugin.** OpenCode (1.19 to 1.x) offers no channel an MCP server can use to start a turn, so
`install --host opencode` installs a small FAI plugin (`plugins/fai-browser.js`) that OpenCode loads at startup; FAI
installs it only on that command (or setup's OpenCode registration), and only replaces a file there that carries its
marker. The plugin runs inside OpenCode with OpenCode's own rights: it has no dependencies, never throws out of a hook,
logs nothing of arguments, texts or its token, and turns itself off when it cannot open its socket safely. It listens
on a private socket (a 0700 directory it owns, never a symlink; the socket 0600, named after OpenCode's pid) and
accepts a request only with the random token it minted at startup. It prompts only root sessions it saw call a FAI
tool (a subagent's call counts for the conversation that started it, so a wake never lands in a task session), only
with one text part that matches one of FAI's three wake templates exactly (ids, a level name, the tool, and for an
invite your words as one quoted line of at most 500 characters), and with the agent and model of that session's last
user message, so a session in `plan` is woken in `plan`, never in OpenCode's default agent; a session without such a
message is not woken. It sends no tool or system field. The MCP server uses the socket only when OpenCode itself is its parent
(socket name and `OPENCODE_PID` both name the parent pid). One OpenCode serves several sessions with one MCP server, so
Approve and Resume wake exactly the session whose call made or joined that request, never a guess; an invite goes to
the only session that used FAI in the last 10 minutes, and with two or more the popup shows the copy line instead.

**Threat model.** Any process running as your user can already write to Claude Code's messaging socket (its path and
token are in the session's environment and its child processes) or run `codex queue`, so FAI adds no new way in: it
uses the same channel, from inside the session's own process tree, with text it authored. A local process with FAI's
client token can register as an agent session and join an invite made for no session in particular (as it could
already request tabs); you see which agent joined in the popup. Claude Code's own `crossSessionInbound` setting
(accept, hold, refuse) still decides what happens to an inbound message; its socket answers nothing either way, so
the popup says "Sent", not "received". A Codex queued message runs with that session's own permissions, never more.
OpenCode adds three things to weigh. FAI's plugin is code of ours running in your agent with its rights: keep it to
the reviewed file `install` copies (or links with `--link`), and remove `plugins/fai-browser.js` to turn wakes off (or
run OpenCode with `--pure`, or `FAI_WAKE=0`). The plugin adds the calling session's id as `_faiHostSession` to every
FAI tool call's arguments, so it shows in OpenCode's tool display and transcript and goes to the model provider with
the tool input: an opaque id, no secret, which the MCP server strips before use. And the socket path and token are in
OpenCode's environment, so everything OpenCode starts afterwards inherits them: its bash tool's children, and its other
MCP servers, language servers and formatters, as with Claude Code's socket variables. Any of them could ask the plugin
to prompt a session that used FAI with one of FAI's exact wake texts (no other text), which is no more than such a
process can already do to Claude Code's socket; the MCP server itself is not fooled (the parent-pid rule),
and the service never passes these variables on to processes it starts.
As before, a process that can read the extension's pairing secret could speak for the extension on the service's
extension channel (approve a request, or make an invite) without your click: keep `.env.local` and the browser
profile to yourself.

## What is and is not protected

| Protected | Not protected |
|---|---|
| Tab choice, origins, level, risky clicks | Prompt injection **within** a level you granted: a malicious page can steer the agent to do Use-level things on that tab |
| Known secrets in text, URLs and screenshots | Secrets with no rule (short passwords in prose, text in canvases or images, frames from origins you did not approve) |
| What the agent holds | What your model provider sees in the redacted page; what a page does with values you let the agent type |
| The pairing secret | A compromised OS account or other malware running as you |

Practical advice: grant the lowest level, use a separate browser profile for agent work, approve deliberately, do not stay
signed in to accounts the task does not need, and never list a production site as a Test site.

**Which build you run.** Every build of the extension shares one extension ID (the manifest `key` pins it), and the native
messaging host trusts that ID. So the host cannot tell an official build from a modified one that carries the same ID. Run only
builds you made from source or took from the official release or store listing, and see [SECURITY.md](../../SECURITY.md) for
the full list of what is not covered.
