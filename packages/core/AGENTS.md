# @codelia/core

The core SDK package. Entry is `src/index.ts`, output is `dist/`.
Place the model definition in `src/models/` and reference it from `DEFAULT_MODEL_REGISTRY`.
The default value of OpenAI is to export `OPENAI_DEFAULT_MODEL` / `OPENAI_DEFAULT_REASONING_EFFORT`.
Include `gpt-5.3-codex` in your OpenAI model definition (to pass Codex OAuth-compatible model selection).
Place the Anthropic (Claude) provider implementation in `src/llm/anthropic/`.
Place the OpenRouter provider implementation in `src/llm/openrouter/`.
Register defaults in `configRegistry` of `@codelia/config` (`src/config/register.ts`).
Place the test under `tests/` and execute it with `bun test`.
Tool-defined JSON Schema generation uses Zod v4's `toJSONSchema`.
Place the DI interface in `src/di/` (e.g. model metadata, storage paths).
Compaction determines the context limit by referring to `modelRegistry` (metadata is reflected in the registry).
Tool output cache is in charge of `ToolOutputCacheService`, and store is supplied from `AgentServices.toolOutputCacheStore`.
The default system prompt is `prompts/system.md` (can be overridden with `CODELIA_SYSTEM_PROMPT_PATH`).
Use `getDefaultSystemPromptPath()` for external references (avoid package.json references).
You can check permission by calling `AgentOptions.canExecuteTool` before running the tool (if it is deny, the tool will not be executed).
If you return `stop_turn: true` to deny of `canExecuteTool`, you can end the turn with permission deny as the final response.
Cross-boundary stable types (`AgentEvent`, `SessionStateSummary`) refer to `@codelia/shared-types`.
`ContentPart` includes `type: \"other\"` for provider-specific extension, and unknown providers convert it to text (degraded).

## runStream events

`Agent.runStream()` yields display events for the UI.
- `text`: For progress/streaming (may be incremental in the future)
- `reasoning`: Summary of inference output and progress (display label on UI side is optional)
- `final`: Turn complete. It also has a body (the UI corresponds to the case where the body comes only with `final`)
`Agent.runStream()` is `llm.request` / `llm.response` if `AgentRunOptions.session` is passed
and `tool.output` to the session store on a best-effort basis.
`Agent.run` / `Agent.runStream` accept user input as `string | ContentPart[]`.
Provide `Agent.getHistoryMessages()` / `Agent.replaceHistoryMessages()` for Session resume,
Used to save and restore historical snapshots.

The OpenAI Responses API requires a corresponding output item immediately after the reasoning item, so
When returning the model, `ChatInvokeCompletion.messages` (`BaseMessage[]`) is the original and history is also maintained in the same format.
OpenAI Responses requests aggregate system messages into `instructions` and send them.
The Developer role will be abolished and will only handle system prompts.
`store` of OpenAI Responses sets `false` when not specified (stateless).
OpenAI Responses is always called with `stream=true` and uses the aggregated result with `finalResponse()`.
Agent passes provider-neutral invoke context `sessionKey` using `session_id` (fallback: `run_id`) so adapters can apply conversation-stable routing hints without provider coupling.
OpenAI Responses adapter maps `sessionKey` to `prompt_cache_key` and sends `session_id: <prompt_cache_key>` header (Codex-compatible routing hint).
Anthropic Messages adapter enables prompt caching by default via top-level `cache_control: { type: "ephemeral" }` (can be overridden per-request).
Set `CODELIA_PROVIDER_LOG=1` to enable provider request/response diagnostics and dumps (OpenAI/Anthropic).
Override dump path with `CODELIA_PROVIDER_LOG_DIR` (default is `./tmp` when provider log is enabled).
Request debug logs include provider-specific hashes (for OpenAI: `tools_sha` / `instructions_sha` / `session_id_header=on|off`) so order/routing drift can be spotted quickly.
When repopulating OpenAI's `response.output` as history, parsed fields such as `parsed_arguments` / `parsed` are removed.
If `output_text` of OpenAI Responses is missing, synthesize it from the `output_text` part of `response.output` and complement it.
`ToolDefinition` supports both function tools and hosted search tools (`type: "hosted_search"`); provider serializers map hosted search to each provider's native tool type.
OpenAI `web_search_call` output items are normalized as `reasoning` messages (status/query/source summary) to make search progress visible in run logs.
`Agent.runStream()` also emits hosted web search lifecycle events (`step_start` / `tool_call` / `tool_result` / `step_complete`, tool=`web_search`, display_name=`WebSearch`) from those callbacks so UI can show them like regular tool cards.
