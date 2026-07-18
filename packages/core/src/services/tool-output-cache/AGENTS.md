# Tool output cache

- Immediate tool-output processing must preserve `ContentPart[]` whenever it contains non-text parts (`image_url`, `document`, or provider-specific `other`). Converting those parts to display text before the next model call destroys multimodal tool results.
- The current cache store is text-only. For multimodal results, persist the text projection for lookup metadata while keeping the original parts in the in-context `ToolMessage`.
- Immediate `maxMessageBytes` truncation applies to text-only output. Multimodal payload bounds belong to the producing tool/client contract until the cache store gains typed content-part persistence.
- Core retains optional total-budget trimming, which may replace an older complete tool message with a text placeholder. Runtime disables this by default and enables it only through `CODELIA_TOOL_OUTPUT_TOTAL_TRIM=1`; keep that opt-in mechanism separate from immediate processing of the fresh result.
