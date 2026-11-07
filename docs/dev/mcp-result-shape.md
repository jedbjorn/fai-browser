# MCP result shape: one model-visible copy

Researched 2026-11-06 from public documentation and source. FAI Browser declares no `outputSchema` on its tools.

## What hosts send to the model

| Host | Evidence | Model-visible result when both channels are present |
|---|---|---|
| Codex CLI | [`CallToolResult::as_function_call_output_payload`](https://github.com/openai/codex/blob/f49ae52079859e9cfff41ed92dd935d022a2da0b/codex-rs/protocol/src/models.rs#L2516-L2551) returns serialized non-null `structured_content` before considering ordinary content. [`McpToolOutput::response_payload`](https://github.com/openai/codex/blob/f49ae52079859e9cfff41ed92dd935d022a2da0b/codex-rs/core/src/tools/context.rs#L227-L257) uses that payload for `function_call_output`. Source snapshot: `f49ae52079859e9cfff41ed92dd935d022a2da0b`. | **`structuredContent` only** (apart from host metadata such as wall time and special encrypted content). Text content is the fallback when structured content is absent. |
| Claude Code | Claude Code is not open source. A protocol-level reproduction on 2.1.126 reports that only `structuredContent` reached the model when both were present ([issue #55677](https://github.com/anthropics/claude-code/issues/55677)). A separate controlled A/B on 2.1.170 found that disabling structured output removed the duplicate structured payload while preserving content images ([issue #70280](https://github.com/anthropics/claude-code/issues/70280)). These are public issue evidence, not a guarantee about every future release. | **Structured preferred in the reproduced versions**; text and image content are the fallback without it. |
| OpenCode 2.0 | [`convertMcpTool`](https://github.com/anomalyco/opencode/blob/0b1b63081c1980200edf0d73726b3ffa5cafe507/packages/opencode/src/mcp/index.ts#L126-L151) returns the complete `CallToolResult` from a `dynamicTool`, with no custom `toModelOutput`. The [AI SDK tool contract](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool#toModelOutput) says that without `toModelOutput` the result is sent as a JSON object. Source snapshot: `0b1b63081c1980200edf0d73726b3ffa5cafe507`. | **The whole result object**, so text and structured content can both be present. Legacy OpenCode V1 instead preferred non-empty text and dropped structured content, as documented in [issue #38923](https://github.com/anomalyco/opencode/issues/38923); its maintainer closed that report as V1-only. |

There is no safe structured-only or structured-plus-text subset: Codex and the reproduced Claude Code versions would see only the subset and lose the page digest, offered action labels, warnings, or other instructions carried by the full text.

## MCP specification

The [2025-06-18 tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) and the later [2025-11-25 version](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content) say the same relevant things:

- Results **may** contain structured or unstructured content. `structuredContent` is optional.
- `outputSchema` is optional. When one is provided, the server **MUST** return conforming structured results and clients **SHOULD** validate them.
- A tool that returns structured content **SHOULD** also put serialized JSON in a text block for backwards compatibility.

There is no requirement to return `structuredContent` when no `outputSchema` is declared. Text-only results are therefore spec-compliant; omitting structured content also avoids the spec's backwards-compatibility JSON mirror.

## Chosen design

**Return one complete, readable text rendering and no `structuredContent` for FAI MCP tool results.** This applies to Agent direct (`open`, `act`, `observe`, `wait`, `status`, `release`, `evidence`) and to Jev `run`, whose summary-plus-full-structured result duplicated information in the same way. Error results were already text-only and remain unchanged. Screenshot and trace content blocks remain; evidence metadata has a short readable first text block rather than a JSON mirror.

The direct text begins with `next (kind): text`, followed by trusted status, grant, ids and revision, then warnings/needs and the page digest, structured result rows when generic records were detected, offered actions, tabs and other page-derived data under the existing untrusted-page-text fence. Result rows carry only typed values, remaining context fields and offered open action ids, bounded to 600 characters by task relevance; omitted rows stay in the digest, and truncation and count/sort/pagination metadata remain explicit. Action ids and approval classes stay visible. Jev keeps its existing `summaryText` rendering, including suggestions, answer data and the bounded earlier-page trail. Secret redaction still runs over the complete outgoing JSON-RPC message, so placeholders and fencing are unchanged.

The token benchmark reports text and structured sizes separately plus host-visible views: Codex/Claude-style structured preference, OpenCode 2 whole-result JSON, and legacy text-only behavior. With no structured channel, every view resolves to the same text.
