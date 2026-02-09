# history (core)

HistoryAdapter は provider ごとに履歴の正本を管理する。
enqueue* は「次回送信に含めるキュー」へ積む操作。
commitModelResponse は送信後のモデル出力を正本に確定させる。
OpenAI 用の adapter は `../llm/openai/history.ts` に配置。
view messages は UI/compaction 用。OpenAI の送信キャッシュは
replaceViewMessages 時に view messages から再構築する。
