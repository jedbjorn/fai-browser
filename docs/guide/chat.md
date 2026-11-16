# The chat panel

Click the **FAI Browser** button on the toolbar, then **Chat**. A panel opens beside the page: Chrome's side panel, or
Firefox's sidebar (**FAI Chat**). It works on Windows, macOS and Linux. Type to an agent there instead of switching to
its terminal or app, and follow what it does in the tab next to it.

The menu (the button at the top left of the panel) lists:

- **New chat**: start an agent from the browser (a FAI chat, below).
- **Chats**: your FAI chats, most recently active first. Open one to read it and carry on.
- **Open agents**: Claude Code, Codex or OpenCode sessions you already run, once they have used FAI.
- **Settings**: the default provider, a model per provider, and Appearance (System, Light, Dark).

The panel shows messages only: what you typed and what the agent wrote, once it has written it. No tool calls, no
thinking, no formatting: text as plain text, links not clickable. **Browsing…** under the last message means the agent
is working. A message is at most 4,000 characters.

## Talk to an agent you already run

Pick it under **Open agents**. The panel opens on the agent that holds a task tab in this window, or on the only one
running. Its conversation appears as its program writes it, and what you send goes to it on the same channel FAI uses
to wake it ([Invites and wakes](../REFERENCE.md#invites-and-wakes)):

| Agent | Needs |
|---|---|
| Claude Code (CLI, or the desktop app's Code tab) | Messaging enabled, FAI started by Claude itself |
| Codex (CLI, or Codex in the ChatGPT app) | The standalone `codex` command line, and one FAI command in that session first |
| OpenCode 1.19 to 1.x (the CLI; OpenCode Desktop on Windows cannot run a turn) | FAI's plugin (setup installs it), and one FAI command in that session first |

Your message shows **Sending…**, then **Sent**, or **Not delivered** with the reason and a **Retry** button. You can
send while the agent is working: Codex and OpenCode take it as the next turn, and Claude Code's own settings decide
what it does with a message while busy. If the panel says
`Can't read this conversation (…)`, FAI could not find or read that program's conversation (a newer version may store
it differently); your messages still reach the agent. Nothing is kept after the panel closes. Details:
[Open agents](../REFERENCE.md#open-agents).

## Start a FAI chat

Open the panel and type. If a coding program is installed and signed in on this computer (Codex, Claude Code or
OpenCode; [install guide](install.md#fai-chats)), it answers there and works in the browser only through FAI. It has no
shell, cannot write files, and reads only the files you attach. Codex is the one exception: a few of its built-in tools
cannot be switched off, and on Windows its image viewer can read any image your user account can read
([Tools and files](../REFERENCE.md#tools-and-files)).

- **The page beside the chat.** When you ask about the page you are on, the agent can join that tab. FAI's usual
  approval window opens: click **Use** or **Act**, or **Deny**. Nothing is granted before you click, and the agent
  learns the site only after you do. A question that needs no page opens nothing. On Firefox the panel can offer
  only a tab you clicked the FAI Browser icon on since it last navigated (opening the panel from **Chat** does that);
  otherwise the agent asks for a site with an ordinary request.
- **Provider and model.** A new chat uses your default provider, or the first available of Codex, Claude and OpenCode;
  pick another before the first message. Each program uses its own default model unless you choose one in Settings,
  whose lists come from the programs themselves (or type a name). OpenCode always needs a model chosen. Changing the
  model in a chat's header applies from its next message. These settings are FAI's own and never change your coding
  app.
- **Attach** files with the paperclip: up to 10 a message, 25 MB each. They are saved in the chat's folder and the
  agent is told where. FAI does not check the type; if the program cannot read it, the agent says so. Codex reads
  images only; Claude also reads PDF and text files; OpenCode reads images and text, and PDF only if its model does
  ([which formats](../REFERENCE.md#attachments)). Attached files go to the provider's service under your account.
  If OpenCode refuses a file, it keeps it in its own session and every later message in that chat fails the same
  way: start a new chat.
- **Stop** ends a running turn. A turn also stops after 30 minutes. Up to three chats can run at once.
- **Come back later.** Open the chat from **Chats** and carry on: the agent continues the same conversation, also after
  a restart.
- **Delete** in the menu removes FAI's copy of the chat and its files from `FAI-Local-Chats`. The provider's program
  keeps its own copy of the conversation, which FAI does not remove.

When a provider cannot start a chat, the panel names one fix, such as `Claude is not signed in. Sign in to the Claude
command line once: run "claude auth login" in a terminal.` When the program itself fails a turn (a model it refuses,
a file it cannot read, a service error), the panel shows its own message under "<Provider> said:". The full list of
lines is in [FAI chats](../REFERENCE.md#providers-and-availability).
