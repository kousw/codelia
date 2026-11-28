# tools/protocol-codegen

Generates deterministic runtime <-> UI wire artifacts from `packages/protocol/src/catalog.ts` (`dev-docs/specs/protocol-codegen.md`). Depend only on `@codelia/protocol` (`workspace:*`, since release scripts only scan `packages/`) and pinned Zod.

- `bun run generate:protocol` writes `packages/protocol/schema/protocol.schema.json` (Biome-excluded), `packages/protocol/schema/methods.md`, `crates/protocol/src/generated.rs` (`#[rustfmt::skip]`), and `packages/protocol/tests/fixtures/protocol/<route>.jsonl`; `bun run check:protocol` verifies in memory (CI).
- **Rules**:
  - Output must be deterministic (sorted definitions/methods, fields in declaration order, no timestamps/absolute paths). Never read Zod internals (`_zod.def`).
  - Fail fast with definition ID and JSON path for anything outside the wire subset; do not add per-method generator options (fix the schema or subset spec instead).
  - Encode compatibility in the generator: open string enums, `Unknown` only for new string tags (missing/mistyped tags error), ignored unknown fields, strict known-variant/boolean decoding, declared null presence.
  - Rust decode positions (runtime-originated params + UI request results + errorData) reject untagged object unions (`tagged`/`keyed` only) and `wireCount()`. String literals outside tags emit `Lit*` unit types (named version literal stays `String`); serialize-only dependencies propagate across aliases/inline nodes.
  - Fixtures declare Rust `expect` (`typed`/`unknown`/`error`), Zod `ts` (`valid`/`invalid`/`skip`), and `lossy` for intentional re-serialization diffs.
