# Conversation reader fixtures (spec #80)

Records taken from real conversation stores on Linux (Claude Code 2.1.321 to 2.1.325, Codex 0.169.0, OpenCode 1.19.5),
one line per real record, with every private value replaced: message texts are rewritten, paths become
`/home/user/demo-repo`, ids of accounts and sessions are fixed placeholders, and any other free text is `fixture`.
Each record keeps its own keys and flags (`isMeta`, `isSidechain`, `origin`, `isCompactSummary`,
`content_item_kinds`, `synthetic`, ...), which is what the readers in `src/chat.js` decide on.

- `claude-code*.jsonl`: one `projects/<slug>/<sessionId>.jsonl`, split where the tests append (`-append` starts a turn
  from the chat panel, `-finish` ends it). Holds a real example of each kind the reader must hide: local command
  wrappers, a skill body, a system reminder, a task notification, a sidechain prompt, an image note, a compact summary,
  tool calls and results, thinking, a queue record, a cut record and an unknown record type.
  `claude-code-2.1.325.jsonl` holds two FAI peer messages as Claude Code 2.1.325 stores them, with its trailer
  ("This came from another Claude session — …") after FAI's text.
- `codex*.jsonl`: one `sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`: developer instructions, the injected
  AGENTS.md and environment items, tool calls, reasoning, commentary and final answers, a cut record, an unknown type.
  `-abort` is a real `turn_aborted` event.
- `opencode.json`: `client.session.messages` data as `opencode export` prints it, with synthetic and ignored parts,
  reasoning and tool parts; `append` ends with an assistant message that is not complete yet.
