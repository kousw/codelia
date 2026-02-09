# @codelia/shared-types

`core/protocol/runtime/storage` で共有する安定型を置くパッケージ。

設計原則:
- 依存は最小（外部SDK/他workspaceパッケージへ依存しない）。
- 型は永続化/RPC/UI再生で長期互換が必要なものに限定する。
- provider固有や実装都合の内部型は置かない。

現時点の対象:
- `AgentEvent` 系
- `SessionStateSummary`
- skills catalog/search に使う `Skill*` 型
  - schema-first: `src/skills/schema.ts` (Zod) + `src/skills/index.ts` (infer types)
