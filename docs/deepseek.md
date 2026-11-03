# DeepSeek

Codelia supports the official DeepSeek API with an API key. Set
`DEEPSEEK_API_KEY` before starting Codelia, or select DeepSeek and enter the key
when prompted. It uses separate credentials from OpenAI/Codex; OAuth login is
not available.

Select either model in the TUI:

```text
/model deepseek/deepseek-flash
/model deepseek/deepseek-v4-pro
```

`deepseek-flash` is the default and currently serves V4.1-Flash-1017. This is
DeepSeek's rolling API name, so it does not pin that version permanently.
Flash accepts images; Pro is text-only. Both support function tools and
low/high/max reasoning. Codelia maps medium/xhigh to high. Fast is unavailable.

The connection uses stateless Responses API streaming. Native server-side search
is not exposed; Codelia's local tools remain available. API usage is billed by
DeepSeek.

See [official model details](https://api-docs.deepseek.com/quick_start/pricing/)
and [Responses API](https://api-docs.deepseek.com/guides/responses_api/).
