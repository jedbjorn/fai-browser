# Getting started

This guide takes you from nothing to an agent reading a page in a tab you approved. About five minutes. The exhaustive
manual is [REFERENCE.md](../REFERENCE.md#one-time-setup).

## What you need

- Node 22 or newer.
- Firefox 140+ (ESR or newer; the launcher can download it from Mozilla), or a Chromium-family browser 116+ (Chrome,
  Chromium, Brave, Edge, Vivaldi) from source.
- Linux or macOS.
- A coding agent that speaks MCP: Claude Code, Codex or OpenCode (any MCP client works through the stdio server).

No account and no API key: by default **your agent drives** and FAI makes no provider calls.

## 1. Install

[install.md](install.md) covers every way in detail: **Download FAI Browser** (official Firefox with a separate FAI
profile, the signed add-on preinstalled and paired), **Add to your Firefox**, and Chromium from source.

```sh
git clone https://github.com/jedbjorn/fai-browser
cd fai-browser
npm ci
npm run setup
```

`npm run setup` is run by you, once:

- creates a pairing secret in your settings directory, mode 0600. You never see or copy it.
- installs the **native messaging host** for every browser it finds, so the extension can pair by itself.
- starts the local service (the "daemon") on `127.0.0.1:4318`.
- asks whether to register FAI Browser with each coding agent on your `PATH` (Claude Code, Codex, OpenCode).
- ends with **Set up the FAI Browser profile for Firefox? [Y/n]** when Firefox is installed (otherwise it prints
  `node src/cli.js launch`, which can download Firefox from Mozilla). Say yes and skip step 2.

Never paste the pairing secret or any key into a chat with an agent, and do not let an agent run setup for you.

**Where things live.** Outside the checkout. On Linux: settings in `~/.config/fai-browser` (`.env.local`, `config.json`, the native
host launcher) and runtime state in `~/.local/state/fai-browser` (`client-token`, `daemon.json`, `daemon.lock`, `logs/`,
`artifacts/` with traces and screenshots, pruned automatically). On macOS both are in `~/Library/Application Support/fai-browser`.
Do not share or commit anything from these directories (`FAI_HOME` puts everything in one directory instead).

## 2. Load the extension

**FAI Browser (Firefox).** Nothing to load: the launcher installed the signed add-on in the FAI profile and opened it with a
welcome page. Open it again from your applications menu ("FAI Browser", Linux) or with `node src/cli.js launch`.

**Your own Firefox.** Install the signed `fai-browser-firefox-<version>.xpi` from the GitHub Releases
([install.md](install.md#2-add-to-your-firefox)).

**Chrome, Chromium, Brave, Edge, Vivaldi (from source).** Open `chrome://extensions` (`brave://extensions`, `edge://extensions`),
turn on **Developer mode**, click **Load unpacked** and select the `extension/` folder. The extension ID is pinned by the
manifest, so the native host already trusts it.

In Firefox the FAI Browser button is on the toolbar from the start; in Chromium **pin the FAI Browser icon** (puzzle-piece
menu, then the pin). It holds the popup's controls and invites, and is one way to approve agent requests.

The extension should now say it is paired. If not, click **Pair with the FAI service** in the popup, or see
[troubleshooting](troubleshooting.md).

## 3. Restart your agent

Restart Claude Code, Codex or OpenCode so it loads the `fai-browser` MCP server and the skill. To register one later:

```sh
node src/cli.js install --host claude     # or codex, opencode; add --scope user for all projects
```

## 4. First task

Serve something harmless locally, or use any public page:

```sh
cd fixtures && python3 -m http.server 8080
```

Ask your agent: *"Use FAI Browser to open http://127.0.0.1:8080/ and tell me what the page says."*

What happens:

1. The agent calls `fai_browser_open` with the origin, a reason and the lowest level that works (Read for a plain look).
2. The page opens in a new task tab in your existing browser window, with a request modal next to it. Click **Approve**
   there (allow the browser's site access if it asks), or click the FAI Browser icon on that tab. You can lower the level
   before approving. (A request for **Act** or **Test site** shows the FAI Browser window first, where you confirm the
   level and click **Open**.)
3. The agent receives the page: a digest, the actions you allowed, a revision.
4. It answers, or acts (`fai_browser_act`) and gets the next page.

Pause or stop at any time from the popup; the tab is marked with a `FAI` tab group while the agent has it. After you
approve or resume, a Claude Code, Codex or OpenCode session that FAI can wake continues by itself (see
[troubleshooting](troubleshooting.md) for the versions); otherwise tell the agent to continue.

You can also start from a page you already have open: the popup's **Invite an agent to this tab** hands that tab to a
running agent session at the level you choose ([REFERENCE: Invites and wakes](../REFERENCE.md#invites-and-wakes)).

## Levels in one minute

| You see | API | The agent may |
|---|---|---|
| **Read** | `read-only` | follow same-site links, scroll, wait |
| **Use** | `reversible` / `interactive` | also click buttons, pick options, fill the values you supplied, search, filter, sort, page |
| **Act** | `full` | also save, send, submit, delete, accept cookies |
| **Test site** | `testing` | everything incl. sign-in and checkout; only for test origins you listed |

Details: [safety-model.md](safety-model.md). Risky clicks (a purchase, a delete, "show API key") additionally ask you:
[approvals.md](approvals.md).

## Without a browser or key

```sh
node --test test/secrets.test.js   # a fast, browserless test file; the full suite is in CONTRIBUTING.md
node examples/fake-demo.js     # an in-memory bridge; observe, then act; prints a result
```

## Next

- [MCP tools](mcp-tools.md): what your agent can call.
- [Secret redaction](secret-redaction.md) and [approvals](approvals.md): what is hidden and what asks.
- [Troubleshooting](troubleshooting.md).
