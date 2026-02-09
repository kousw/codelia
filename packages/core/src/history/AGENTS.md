# history (core)

HistoryAdapter manages the authoritative history for each provider.
enqueue* is an operation to put in the "queue to be included in next transmission".
commitModelResponse confirms the model output after sending as the original.
The adapter for OpenAI is placed in `../llm/openai/history.ts`.
view messages is for UI/compaction. OpenAI's send cache is
Rebuild from view messages when replaceViewMessages.
