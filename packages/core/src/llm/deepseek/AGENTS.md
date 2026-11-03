# DeepSeek Responses adapter

`ChatDeepSeek` composes `ChatResponses` with the fixed official endpoint and
independent API-key auth. Flash is selected as `deepseek-flash` (currently
V4.1-Flash-1017); Pro is `deepseek-v4-pro`. Preserve plaintext Responses reasoning
items in raw history across tool-result replay. Flash alone accepts images.
Effort is low/high/max; medium and xhigh map to high with diagnostics. None is
not exposed by current Codelia reasoning controls. No native web search or Fast.
Live thinking-mode named tool choice returned HTTP 400 on 2026-11-02; reject it
locally. Automatic tool selection and tool-result replay passed for both models.
Low-effort calls need not emit a reasoning item; preserve it when present.
