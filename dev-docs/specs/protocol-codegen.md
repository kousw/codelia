# Protocol schema and code generation (B-024)

**Status: Implemented** (Phases 0-4, 2026-11-22/23; notes in sections 12-14).
Every protocol method is in the catalog and runs on the generated pipeline.
Extracting a shared `crates/protocol` crate is deferred until the desktop host
lands on main (section 11.4).

This document defines how the runtime ⇄ UI protocol (`dev-docs/specs/ui-protocol.md`)
gets a single schema source, runtime validation and generated Rust types for the
TUI. It does not change the wire format or `protocol_version: "0"`.

## 1. Problem and goals

Today the contract is written three times by hand:

- `@codelia/protocol` / `@codelia/shared-types` hold TypeScript types only. The
  method list (`ProtocolMethod`) is not linked to params or result types and has
  already drifted: `client.tool.cancel` is sent but not listed, and the
  `goal.updated` / `goal.cleared` / `goal.ready` notifications have no types.
- The runtime casts params (`req.params as XxxParams`) and receives UI results
  through generic casts (`waitForUiResponse<ClientToolCallResult>`). Only
  `goal.*`, `sandbox.*` and `auto_review.configure` validate with local Zod
  schemas that duplicate the protocol types.
- The TUI reads `serde_json::Value` by string keys and builds requests with
  `json!`. A renamed or retyped field fails silently at run time.

Goals:

1. One source for each wire shape, from which TS types, runtime validation and
   Rust types are derived.
2. A method catalog that binds method name, direction, params, result and
   capability, for all four JSON-RPC routes.
3. Compatibility rules that are encoded in generated code and checked in CI.
4. Incremental adoption, one vertical slice at a time, with no behavior change
   for unmigrated methods.

Non-goals:

- Typing `tool_result.result` (a display string the TUI parses per tool),
  `tool_call.args`, client tool definitions, or other declared JSON extension
  points. They stay `unknown` / `serde_json::Value`.
- Capability negotiation, ordering, timeouts, retries, replay and UI state
  transitions. Generated code covers structure only.
- Migrating persisted session files.

## 2. Decisions

| Topic | Decision | Not chosen |
| --- | --- | --- |
| Source | Zod 4 schemas in `shared-types` and `protocol` | Reading existing TS types with the Compiler API (cannot carry integer, null or open-enum semantics; needs a second validator generator); Rust as source; TypeSpec / protobuf |
| Intermediate | Official `z.toJSONSchema(..., { io: "input" })` plus `x-codelia-*` metadata, committed as `protocol.schema.json` | Walking Zod internals (`_zod.def`), which is not a stable API |
| Rust emitter | In-repo TS generator over a restricted JSON Schema subset | typify (0.8 misdecodes tagged unions; 0.10 needs rustc 1.97) |
| Rust location | `crates/tui/src/protocol/` first; extract a `crates/protocol` crate when a second Rust client exists | New crate now (needs a Cargo workspace and CI/release changes) |
| Generated files | Committed; CI regenerates in memory and fails on any difference | Build-time generation (the `tui` CI job and Cargo-only builds have no Bun) |
| Adoption | Vertical slice of nine methods first, then the rest by route | Converting every type at once |

## 3. Schema source

### 3.1 Ownership and naming

- `@codelia/shared-types` owns shapes that are also persisted or replayed
  (`AgentEvent`, `ContentPart`, `RunErrorInfo`, `LlmCallTiming`, `GoalOffer`,
  `TaskSummary`, ...). `@codelia/protocol` owns params, results, notifications
  and the method catalog. Dependency direction stays `protocol → shared-types`.
- `@codelia/protocol` adds `zod` as a runtime dependency. The published
  packages (shared-types, protocol) take a caret range (`^4.4.3`) so installs
  share one Zod with core, runtime and cli; the private `protocol-codegen`
  pins the exact version, and `bun.lock` keeps generated output from drifting.
- Each wire shape is a schema constant named `<Type>Schema` plus a type with the
  existing public name:

  ```ts
  export const RunStatusNotifySchema = z.object({ ... }).meta({ id: "RunStatusNotify" });
  export type RunStatusNotify = z.infer<typeof RunStatusNotifySchema>;
  ```

  Public type names and import paths do not change. Schemas are exported from
  the package entry for runtime use.

### 3.2 Wire subset

The generator accepts only the constructs below and stops with the method name
and JSON path for anything else.

| Need | Write | Notes |
| --- | --- | --- |
| Object | `z.object` | Unknown keys are stripped on TS receive and ignored on Rust receive. |
| Object whose unknown keys must be rejected | `z.strictObject` | Use where an extra key makes the request unsafe or ambiguous, including each `task.spawn` and `permissions.remove` branch and the removal rule. Results keep accepting additive keys. |
| Open extension object | `z.looseObject` | Declared extension points only, e.g. `AgentEventNotify.meta`. |
| Safe integer literal | `z.literal(1)` | Numeric consts must be safe integers. |
| Integer | `wireInt()` (`z.int()`) | Counters, `seq`, sizes, millisecond timestamps, HTTP status. Rates, costs and measured durations stay `z.number()` unless their contract says integer. |
| Optional and nullable | `clearable(T)` or `nullish(T)` | Mandatory; see 3.3. A bare `.nullable().optional()` is a generation error. |
| Required and nullable | `T.nullable()` | The key is always sent; `null` has a meaning (e.g. `run.metrics` clears the rate). |
| String set | `z.enum([...])` | Open on Rust receive (section 5). |
| Tagged union | `tagged(tag, [...])` | Every branch has a required literal at `tag`; values are unique strings or the booleans `true`/`false`. Nested tagged unions are allowed (`llm.status` splits on `kind` inside `type`). |
| Primitive-kind union | `z.union` | Branches have different JSON kinds, e.g. `string \| ContentPart[]`. |
| Key-presence object union | `keyed([...], meta)` | Each branch declares its own required identifying key. Other overlapping untagged unions are limited to send positions. |
| Map | `z.record(z.string(), T)` | |
| Opaque JSON | `z.unknown()` | Declared extension points only. |

Forbidden in wire schemas: `.default()`, `.transform()`, `.preprocess()`,
`z.intersection` (use `.extend()`), recursive `z.lazy`, `z.any`, dates and
bigints. Normalization stays in handlers. In version 0, the runtime normalizes only
the `model.set.reasoning` field before catalog validation as described in §8.

Every exported schema and every tagged-union branch carries
`.meta({ id })`. Ids are unique across both packages and become Rust type names.
`.describe()` text becomes a Rust doc comment.

A union whose branches overlap as supersets is normalized before cataloguing.
`TaskSpawnResult = TaskSummary | TaskInfo` becomes `TaskInfo`, whose extra
fields are already optional. The wire is unchanged and the old and new TS types
are mutually assignable.

### 3.3 Null semantics

| Helper | Meaning | JSON Schema | Rust |
| --- | --- | --- | --- |
| `clearable(T)` | absent = keep, `null` = clear, value = set | `x-codelia-presence: "tri-state"` | `Patch<T>` |
| `nullish(T)` | absent and `null` both mean "not reported" | `x-codelia-presence: "collapse"` | `Option<T>` |

Example: `GoalSetParams.token_budget` is `clearable(wireInt())` because the
runtime keeps the budget when the key is absent and removes it on `null`.
`ToolResultEvent.screenshot_base64` is `nullish(z.string())`. There are 17
optional-and-nullable fields in the two packages today; each needs a decision
when its type is converted.

### 3.4 Helpers

`@codelia/shared-types` exports `wireInt`, `clearable`, `nullish` and `tagged`
from `src/wire.ts`. `tagged(tag, branches, { id })` returns
`z.discriminatedUnion` (Zod 4 accepts string and boolean literals) with
`.meta({ id, "x-codelia-tag": tag })`, so the generator never infers the tag.
JSON Schema output does not keep Zod's discriminator.

## 4. Method catalog

### 4.1 Shape

`packages/protocol/src/catalog.ts` lists every method:

```ts
export const protocolMethods = defineMethods({
  "theme.set": request({
    from: "ui",
    params: ThemeSetParamsSchema,
    result: ThemeSetResultSchema,
    capability: "supports_theme_set", // keyof ServerCapabilities
  }),
  "client.tool.call": request({
    from: "runtime",
    params: ClientToolCallRequestParamsSchema,
    result: ClientToolCallResultSchema,
  }),
  "ui.confirm.request": request({
    from: "runtime",
    params: UiConfirmRequestParamsSchema,
    result: UiConfirmResultSchema,
    uiCapability: "supports_confirm", // keyof UiCapabilities
  }),
  "run.status": notification({ from: "runtime", params: RunStatusNotifySchema }),
  "ui.context.update": notification({ from: "ui", params: UiContextUpdateParamsSchema }),
});
```

`capability` is type-checked against `keyof ServerCapabilities` for UI-originated
requests and `uiCapability` against `keyof UiCapabilities` for runtime-originated
ones. The catalog records gating only; enforcement stays where it is today.

The four routes:

| Route | Examples | TS side | Rust side |
| --- | --- | --- | --- |
| UI → runtime request | `initialize`, `run.start`, `theme.set` | validate params, typed reply | `ClientRequest` marker, typed result decode |
| UI → runtime notification | `ui.context.update` | validate params | `ClientNotification` marker |
| Runtime → UI notification | `run.*`, `agent.event`, `goal.*`, `client.tool.cancel` | typed send | `ServerNotification` enum |
| Runtime → UI request | `ui.confirm.request`, `ui.pick.request`, `client.tool.call` | typed send, validate UI result | `ServerRequest` enum, typed reply |

### 4.2 Derived types

- `ParamsOf<M>`, `ResultOf<M>` and `MethodsFrom<"ui" | "runtime">` are derived
  from the catalog in TS.
- During migration `ProtocolMethod = keyof typeof protocolMethods | LegacyMethod`,
  and a method moves out of `LegacyMethod` in the same change that catalogues it.
  After migration `ProtocolMethod` is derived from the catalog alone.
- Cataloguing fixes the known gaps: `client.tool.cancel` gets listed, and
  `ui.pick.cancelled` and the `goal.*` notifications get params types.

## 5. Generation pipeline

`tools/protocol-codegen/` (with its own `AGENTS.md` / `RULES.md`) provides:

- `bun run generate:protocol`: writes all outputs.
- `bun run check:protocol`: regenerates in memory and fails on any missing,
  extra or different file. Part of the `js` CI job.

Steps:

1. **JSON Schema.** Import the catalog (which registers every `id`), call
   `z.toJSONSchema(registry, { target: "draft-2020-12", io: "input" })` and add
   `x-codelia-protocol-version` and `x-codelia-methods` (kind, from, params,
   result, capability as `$ref`s). Write
   `packages/protocol/schema/protocol.schema.json`. Input mode is required:
   output mode adds `additionalProperties: false` to every object, which would
   reject additive fields.
2. **Subset and direction checks.** Enforce section 3.2 on the JSON Schema,
   including presence metadata, tagged branch constraints and supported
   keywords. Build the type dependency graph in `model.ts`. Its decode roots
   are runtime-originated params and results of UI-originated requests.
   Its encode roots are UI-originated params and results of runtime-originated
   requests. Check their reachable nodes before writing artifacts.
3. **Rust.** Emit `crates/tui/src/protocol/generated.rs` (section 6). Output is
   deterministic: definitions sorted by id, fields in declaration order, no
   timestamps or absolute paths.
4. **Fixtures.** Write `packages/protocol/tests/fixtures/protocol/*.jsonl` from
   TS sample definitions after validating each sample with its Zod schema
   (section 10).

## 6. Rust mapping

| Schema | Rust |
| --- | --- |
| `string` / `integer` / `number` / `boolean` | `String` / `i64` / `f64` / `bool` |
| String or integer literal outside a tag | Validated unit type, with a `String` alias for the protocol version |
| Opaque value / open object | `serde_json::Value` / `serde_json::Map<String, Value>` |
| Record | `BTreeMap<String, T>` |
| Object | Struct decoded from a map only. Unknown fields are ignored. A loose object keeps extra keys with `#[serde(flatten)]`. |
| Optional | `Option<T>`. An absent key defaults to `None`. A present value is decoded as `T`, including `null` only if `T` admits it. |
| Required nullable | `Option<T>`, serialized as `null` |
| Tri-state / collapse | `Patch<T>` / `Option<T>` |
| String enum | Open enum with `Unknown(String)`, via `#[serde(from = "String", into = "String")]` |
| Tagged union, string tag | Enum whose variant structs omit the tag. `Serialize` is derived with `#[serde(tag = ...)]`. `Deserialize` is generated: a known tag decodes strictly and returns its error, and an unknown tag becomes `Unknown(serde_json::Value)` with the raw value kept. |
| Tagged union, boolean tag | Enum with exactly two variants named by branch ids. No `Unknown`; a missing or non-boolean tag is an error. |
| Primitive-kind union | `#[serde(untagged)]` enum |
| Encode-only object union | `#[serde(untagged)]` enum deriving `Serialize` only |
| `RpcErrorCode` | `i64` plus constants generated from `RPC_ERROR_CODE` |

Safe integers decode by numeric value. For example, `1`, `1.0`, and `1e0` all
serialize back as `1`. Values outside the JS safe integer range and
fractional values fail to decode.

All generated items are `pub(crate)`. Rust keywords become raw identifiers
(`r#type`).

The tagged-union `Deserialize` is generated rather than derived. A derived
`#[serde(untagged)] Unknown` catch-all also captures malformed known variants
(`{"type":"text","content":5}` became `Unknown` in the spike), which hides real
contract breaks.

## 7. Rust method layer and TUI integration

Hand-written `crates/tui/src/protocol/mod.rs` holds:

- `#[rustfmt::skip] mod generated;`, so a local `cargo fmt` never creates
  regeneration diffs.
- `Patch<T>` (`Absent | Null | Value(T)`) with its serde impls.
- `DecodeError { method: String, source: serde_json::Error }`.
- `IncomingMessage::classify(line)`: `id` + `method` → request, `method` only →
  notification, `id` + `result`/`error` → response.

`generated.rs` adds:

```rust
pub(crate) trait ClientRequest {
    const METHOD: &'static str;
    const CAPABILITY: Option<&'static str>;
    type Params: Serialize;
    type Result: DeserializeOwned;
}
pub(crate) trait ClientNotification { const METHOD: &'static str; type Params: Serialize; }

pub(crate) enum ServerNotification { RunStatus(RunStatusNotify), /* ... */ Unknown { method: String, params: Value } }
pub(crate) enum ServerRequest { ClientToolCall(ClientToolCallRequestParams), /* ... */ Unknown { method: String, params: Value } }
pub(crate) trait ServerRequestReply { const METHOD: &'static str; type Result: Serialize; }
```

`ServerNotification::decode` and `ServerRequest::decode` take the method and
params and return `Result<Self, DecodeError>`.

TUI usage:

- Sending: `send_request::<R: ClientRequest>(params)` writes the envelope and
  registers the pending id. `PendingRpcMatch` variants carry the request marker,
  so the response is decoded with `R::Result`. This also gives `initialize` a
  pending match (it currently reruns capability parsing on every response).
- Receiving: the parser classifies the line, decodes it into
  `ServerNotification` / `ServerRequest`, and hands typed values to the existing
  presentation code. Wire decoding and display formatting are separated in
  `parser.rs` as methods migrate.
- Errors: a decode error for a known method or tag is logged as a protocol
  mismatch (method and JSON path, no payload values) and shown as one
  diagnostic line. The stream continues; nothing panics, and the error is never
  converted to `Unknown`. For replayed history events (`meta.replayed: true`),
  the TUI falls back to the legacy `Value` rendering until that renderer is
  removed in Phase 3.
- `Unknown` notifications and events keep today's behavior: ignored, or shown
  through the existing generic fallback.

## 8. Runtime integration

- **Request dispatch.** Order: unknown method (`METHOD_NOT_FOUND`), then the
  existing per-method gates (capability, busy), then `safeParse` of params, then
  the handler. A parse failure answers once with `INVALID_PARAMS` (-32602) and
  `error.data = { issues: [{ path, code, message }] }`, bounded to 10 issues and
  never echoing input values. Handlers receive the parsed params typed as
  `ParamsOf<M>` and a reply function bound to the request id that accepts only
  `ResultOf<M>`.
- **Structural and semantic checks.** Strict catalog request objects cover
  `task.spawn`, `permissions.remove`, `sandbox.get/set`,
  `auto_review.configure`, `image.model.configure`, `image.artifact.get`,
  and `goal.*`. Unknown keys in those objects fail with `INVALID_PARAMS`
  before handler logic. Keep provider/field combinations, authorization,
  goal identity and revision matching, and semantic bounds in handlers.
  Derive request-only shapes when the same fields are used by a result or
  notification, as `GoalContinueParams` does with `GoalOffer`.
- **Version 0 model selection.** After the busy gate, `model.set` trims and
  lowercases a string `reasoning` before catalog validation. An empty string
  still acts as omitted. The request and result schemas retain the canonical
  reasoning enum. All other fields pass through this step untouched.
- **Outgoing messages.** Typed helpers (`notify<M>`, `requestUi<M>`, typed
  `reply`) send the caller's object unchanged. Zod `parse` strips unknown keys,
  so its output is never sent. Outgoing payloads are checked against the schema
  only when `CODELIA_PROTOCOL_ASSERT=1`, which the runtime test preload sets.
  Production skips the check; it costs about 0.18 µs per message, so the reason
  is to avoid new failure modes, not cost.
- **UI results.** Results of runtime-originated requests (`client.tool.call`,
  `ui.*.request`) arrive as unvalidated data from
  `RuntimeState.waitForUiResponse`. `parseUiResult` validates the reply and
  reports schema issues on failure. A mismatch logs those issues.
  `client.tool.call` returns `{ ok: false, error }` to the model and dialog
  requests treat the reply as declined.

## 9. Compatibility rules

Within `protocol_version: "0"`:

- Receivers accept additive result and notification fields. Rust ignores
  unknown fields and preserves unknown string enum values and tags. Zod
  strips unknown keys in ordinary result and notification objects.
- Add an optional field to a strict request with an explicit server
  capability for that extension. The UI sends the field only after
  `initialize` advertises support. An older runtime rejects the extra key
  even when the field is optional in the new schema.
- Negotiate new authority or changed behavior on both strict and stripping
  requests. The capability must cover the new semantics. If authorization
  or scope depends on a new field, a client without the capability must
  stop before sending the request. Dropping the field could invoke the
  older, broader operation. Existing clients keep the behavior they get
  from the old request shape.
- Removing or renaming fields, narrowing value types, adding required fields
  and removing enum variants are breaking wire changes.
- The optional Steer client IDs extend version 0. Older runtimes may
  return only the server ID. Clients use the echoed ID for correlation
  when present and the version-0 server ID when absent. See
  [TUI mid-run Steer](tui-run-steer.md#52-runsteer-rpc).

### 9.1 Stored history and live wire versions

`packages/storage` owns the persisted formats and their version markers.
The [conversation archive](conversation-archive.md) retains original messages
and active resume checkpoints under their storage contracts. The catalog
defines the live RPC payloads and uses the negotiated `protocol_version`.
Changing that version does not migrate original messages, checkpoints, or
run logs.

When an older stored record needs adaptation, the runtime projects it at
the `session.history` boundary in `packages/runtime/src/rpc/history.ts`.
For example, legacy non-object `tool_call.args` are represented as
`{ "_raw": ... }` on the current wire, using saved string `raw_args` when
available. Projection leaves stored bytes untouched. Live event schemas
retain compatible optional fields where possible. If a storage format
needs to evolve, version and read it at the storage boundary with legacy
coverage. Keep replay projection independently tested against the current
catalog.

## 10. Testing and CI

- **`js` job.** `bun run check:protocol`, plus schema tests per method: valid
  and invalid samples, strict params rejecting extra keys, and the
  `INVALID_PARAMS` shape.
- **`tui` job.** Compiles the generated module and runs contract tests over the
  committed fixtures. Each positive sample decodes to a non-`Unknown` value and
  re-serializes to the same JSON. Numbers are compared numerically because
  `f64` writes `1900` as `1900.0`, and `null` equals absent only for collapse
  fields. Each negative sample produces its declared outcome.
- **Fixture format** (one JSON object per line):

  ```json
  {"case":"unknown event type","route":"runtime_to_ui_notification","message":{...},"expect":"unknown"}
  ```

  `expect` is `typed`, `unknown` or `error`. The existing
  `steer-cancel.jsonl` trace stays and is also decoded through the typed path.
- **TS type parity.** A change that converts an existing type adds a
  compile-time assertion that `z.infer` equals the old hand-written type
  (mutual assignability for intersection types), then deletes the old type in
  the same change.

## 11. Migration plan

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 1. Vertical slice (done) | Helpers, catalog, generator, CI checks, and nine methods wired on real paths: `initialize`, `theme.set`, `goal.set`, `run.steer`, `run.status`, `run.metrics`, `agent.event`, `client.tool.call`, `client.tool.cancel` | Covers tri-state, string/nested/boolean tags, open enums, both send directions and a runtime → UI request. Fixtures pass in both languages, and no method needs a hand-written compatibility adapter. |
| 2. UI → runtime requests (done) | Remaining requests; local schemas removed; `json!` request building replaced by `send_request` | No `req.params as` casts remain; `PendingRpcMatch` decodes typed results. |
| 3. Runtime → UI (done) | Remaining notifications and requests; `parser.rs` split into wire decode and presentation; legacy replay rendering removed | No protocol `Value` parsing remains in the TUI except declared extension points. |
| 4. Consolidation (done except the crate) | `ProtocolMethod` derived from the catalog; method table for `ui-protocol.md`; strict string literals; extract `crates/protocol` once the desktop host needs it | `LegacyMethod` is gone; the shared crate waits for the desktop host on main. |

Phase 1 reimplements `theme.set` and `client.tool.cancel` on this pipeline. A
separate uncommitted pilot that read the existing TS types with the Compiler API
covered those two methods; it is not merged, and its fixture ideas (shared JSON
cases in both directions) are folded into section 10.

### 11.1 Per-method steps

Every later phase moves methods with the same steps as Phase 1:

1. Write the params and result schemas as Zod with `.meta({ id })`, using
   `wireInt`, `clearable` / `nullish` and `tagged` where they apply. Check
   `z.infer` against the old hand-written type before deleting it.
2. Add the method to `protocolMethods` and remove it from `LegacyMethod`.
3. Run `bun run generate:protocol` and add samples to
   `tools/protocol-codegen/src/samples.ts`: at least one valid case, one
   malformed known shape, and an unknown enum or tag value where one exists.
4. Runtime: parse UI-originated params with `parseRequestParams` after the
   existing gates, and send results, notifications and requests with the typed
   builders in `packages/runtime/src/rpc/protocol.ts`.
5. TUI: send with `send_request::<methods::X>`, decode results in the matching
   `PendingRpcMatch` arm, and dispatch received methods through
   `ServerNotification` / `ServerRequest`.

Methods can move in groups, one change per group, as long as each change keeps
`check:protocol` and both test suites green.

### 11.2 Phase 2: UI → runtime

Methods still outside the catalog, by area:

| Area | Methods |
| --- | --- |
| Run and attachments | `run.start`, `run.cancel`, `attachment.upload.begin`, `attachment.upload.chunk`, `attachment.upload.finish`, `attachment.upload.cancel` |
| Goals | `goal.get`, `goal.pause`, `goal.resume`, `goal.clear`, `goal.continue` |
| Sessions | `session.list`, `session.history`, `session.open`, `session.update` |
| Auth | `auth.status`, `auth.login`, `auth.login.complete`, `auth.login.cancel`, `auth.logout` |
| Config, permissions, sandbox | `config.get`, `config.set`, `permissions.list`, `permissions.remove`, `permissions.projectTrust.set`, `sandbox.get`, `sandbox.set`, `auto_review.configure` |
| Models and images | `model.list`, `model.set`, `image.model.get`, `image.model.configure`, `image.artifact.get` |
| Shell | `shell.exec`, `shell.start`, `shell.list`, `shell.status`, `shell.output`, `shell.wait`, `shell.detach`, `shell.cancel` |
| Tasks | `task.spawn`, `task.list`, `task.status`, `task.wait`, `task.cancel`, `task.result` |
| Other | `tool.call`, `mcp.list`, `skills.list`, `context.inspect`, `context.usage`, and the `ui.context.update` notification |

Work beyond the per-method steps:

- `run.start` takes typed `RunInput`. The composer keeps assembling JSON
  (with TUI-local staged attachment parts, which uploads replace before the
  send); `wire_value` in `client.rs` converts it to `RunInput` at the send
  boundary for `run.start` and `run.steer`, and a mismatch fails the send.
- Runtime-local validation schemas move into the catalog schemas. Semantic
  checks that a wire schema cannot express (trimming and bounds in
  `GoalController`) stay in the handler and run after `parseRequestParams`.
- The remaining `json!` request building in `app/runtime/client.rs` and the
  `goal.resume` / `goal.clear` JSON params are replaced by `send_request`.
- Session resume keeps its existing order: `session.open` binds the session
  before a session-scope `model.set`. Typed requests must not change it.

### 11.3 Phase 3: runtime → UI

Methods still outside the catalog:

| Kind | Methods |
| --- | --- |
| Notifications | `run.context`, `run.diagnostics`, `run.context.usage`, `goal.updated`, `goal.cleared`, `goal.ready`, `auth.login.status`, `task.progress`, `ui.pick.cancelled` |
| Requests | `ui.confirm.request`, `ui.prompt.request`, `ui.pick.request` |

Work beyond the per-method steps:

- The three `ui.*` requests join `ServerRequest` with typed replies, and
  `packages/runtime/src/rpc/ui-requests.ts` validates the UI result with
  `parseUiResult`, as `client.tool.call` does. The TUI answers a malformed
  request right away, so the runtime does not wait for its timeout.
- Opt-in notifications keep their capability gates (`supports_context_usage`,
  `supports_task_progress`, `supports_goals`) in the catalog entry.
- `parser.rs` is split into wire decoding (classification and generated
  types) and presentation (log lines and state updates). Presentation code
  takes generated types only.
- `parser/legacy_events.rs` is removed. A replayed history event that fails
  strict decoding is shown as one diagnostic line naming its event type.
  The history reader projects older stored events to the live wire where needed
  (§9.1).
- `steer_applied` content decodes through the generated `RunInput` types.

### 11.4 Phase 4: consolidation

- `ProtocolMethod` is derived from the catalog and `LegacyMethod` is deleted.
- An optional generated method table (method, direction, kind, capability
  gate) for `ui-protocol.md`; its prose sections stay hand-written.
- The Rust module moves to a shared `crates/protocol` crate when the desktop
  host needs the same types. The desktop branch keeps hand-written wire types
  in its host crate with a lenient decode policy (ill-typed known payloads
  become `Unknown`), so sharing needs a decision on that policy. It is decided
  when the desktop host lands on main and adopts the generated types.
- Open items from the Phase 1 notes (section 13):
  - String literals outside tags (`"application/pdf"`, `"openai"`, the
    protocol version `"0"`) still decode as any `String` in Rust. Making them
    strict needs a decision for `protocol_version`, where the TUI must be able
    to read and report a mismatched version.
  - Decode errors name the method, tag and field but not the JSON path.

## 12. Phase 0 evidence

The spike converted the envelope, `initialize`, `run.status`, `run.metrics`,
`AgentEvent` (17 variants), `RunInput` and `goal.set` to Zod.

- `z.infer` equaled the hand-written types for 16 schemas exactly and for the
  two intersection-typed ones (`AgentEventNotify`, `GoalSetParams`) by mutual
  assignability. A one-field negative control failed `tsc`.
- The generated Rust (custom emitter) passed 11 contract tests. These covered
  23 Zod-validated samples round-tripping, the shared Steer fixture, an unknown
  event type, an unknown enum value, an unknown field, a malformed known event,
  tri-state `token_budget`, required `null`, and typed request envelopes.
- typify 0.8 on the same JSON Schema got 6 of 9 cases wrong. It decoded
  `reasoning` as `TextEvent`, `reasoning.delta` as `TextDeltaEvent`, and a
  malformed `text` as `CompactionStartEvent`. It rejected an unknown event type
  and an unknown `RunStatus`, and it turned `token_budget: null` into an absent
  key on re-send.
- `safeParse` cost about 0.18 µs per `agent.event` or `run.steer` message.

Not covered by the spike: boolean tags, encode-only object unions, runtime →
UI requests and the `ServerRequest` layer. Phase 1 covers all but encode-only
unions, which no catalogued method uses yet.

## 13. Phase 1 implementation notes

Historical. Where these notes say a method is not catalogued or still uses
JSON, section 14 supersedes them.

Layout:

- Schemas: shared-types `wire.ts`, `content.ts`, `events.ts`, `goal.ts`,
  `approval.ts`, `attachment.ts`, `image-artifact.ts`, `llm-timing.ts`,
  `provider.ts` and `run-error.ts`; protocol `capabilities.ts`,
  `client-tools.ts`, `goal.ts`, `initialize.ts`, `permissions.ts` (sandbox and
  auto-review enums), `run.ts`, `theme.ts` and `version.ts`. Every converted
  type was checked against its previous hand-written type (34 exact, 2
  intersection types by mutual assignability) before the old type was removed.
- Catalog: `packages/protocol/src/catalog.ts`; `ProtocolMethod` is
  `CatalogMethod | LegacyMethod` with a compile-time overlap check.
- Generator: `tools/protocol-codegen/` (workspace package). Outputs are listed
  in its `AGENTS.md`. The schema JSON is excluded from Biome formatting.
- Rust: `crates/tui/src/protocol/` (`mod.rs`, `generated.rs`, `tests.rs`).
- Runtime: `packages/runtime/src/rpc/protocol.ts`. The root `bunfig.toml`
  preloads `scripts/test-preload.ts`, which sets `CODELIA_PROTOCOL_ASSERT=1`.

Decisions made while implementing:

- `initialize` params keep `protocol_version` and `client` optional. The
  runtime always accepted `{}` (embedded hosts and tests send it), so making
  them required would narrow the contract. The TS type widened accordingly.
- `ClientToolCallSuccess.result` is an opaque JSON extension point
  (`unknown`). The runtime already normalizes any value;
  `ClientToolResultValue` stays as a documentation type for senders.
- `tagged(tag, branches, { id })` takes the id directly. Tagged branches must be
  named and may not be referenced outside their union, because the Rust struct
  omits the tag field.
- A required nullable key must be present when Rust decodes it
  (`deserialize_required_nullable`); serde would otherwise read a missing
  `Option` as `None`. Structs without required fields derive `Default`, and
  open enums expose `as_str()`.
- Decode errors name the method, the known tag and the serde message with
  literal values removed (`redact_values`). A JSON path would need an extra
  crate; the tag plus field name has been enough to locate mismatches.
- `PendingRpcMatch::Initialize` decodes the `initialize` result; capability
  parsing no longer runs for every response.
- A `client.tool.call` that fails to decode is answered with
  `{ ok: false, error }` so the runtime does not wait for its timeout.
- Dispatch order per method: `initialize` has no gate; `theme.set` validates
  after its enable gate and busy check; `goal.set` after the goals gate, and
  `GoalController` still applies its semantic schema (trimming and bounds)
  until Phase 2; `run.steer` replaces the previous hand-written shape checks.
- The composer still builds run input as JSON (with TUI-local staged
  attachment parts). `run.steer` converts it to `RunInput` at the send
  boundary; the composer moves to typed input with `run.start` in Phase 2.
- `steer_applied` content and `goal.resume` / `goal.clear` params still pass
  through JSON in the TUI. `goal.updated` / `goal.cleared` / `goal.ready` are not
  catalogued yet but decode into the generated `GoalSnapshot`.
- TUI unit tests that omit protocol fields the renderer never reads (`seq`,
  timestamps, ids) complete them through `parser::test_support`; contract
  tests call the parser and the generated decoders directly.
- String-tagged unions decode `Unknown` only for an unknown string tag. A
  missing or non-string tag (including a nested `llm.status` without `kind`) is
  a decode error, matching the boolean-tagged unions.
- Boolean literal fields (`run.steer` `ok: true`) are `ConstBool<V>` in Rust
  and reject the other value. The TUI does not report a steer as queued when
  its result fails to decode. String literal fields outside tags still decode
  as `String`.
- An optional opaque field (`ClientToolCallSuccess.result`) decodes an explicit
  `null` as `Some(Value::Null)` (`deserialize_present`), so absence and `null`
  round-trip separately.
- Core keeps `tool_call.args` an object: unparsable or non-object model
  arguments (`null`, arrays, scalars) become `{ _raw }`. Tool execution reads
  the raw argument string, so only the display payload changes.
- `@codelia/protocol-codegen` depends on `@codelia/protocol` through
  `workspace:*`. The version bump and sync scripts only scan `packages/`, so a
  pinned version would drift and resolve from the registry.

## 14. Phase 2-4 implementation notes

Generator and schema subset:

- `keyed(branches, { id })` (shared-types `wire.ts`) is a union without a
  discriminator whose branches each have a required key no other branch
  declares. Like the Zod union, Rust takes the first branch in declared order
  that decodes, so an added optional field cannot steer the choice. Used by
  `permissions.remove` params/result and `shell.wait`. Prefer `tagged` for
  new shapes.
- `wireCount()` is a UI-sent count, limit or position that the runtime
  truncates (list limits, `shell.output` offsets, `session.history` limits,
  client tool `timeout_ms`, selection positions). Zod accepts any number, as
  protocol version 0 always did; Rust sends integers, and the subset check
  forbids it where the TUI decodes. Values the runtime requires to be safe
  integers (attachment sizes and offsets, `max_steps`, goal fields) stay
  `wireInt()`.
- A required `z.unknown()` field must be present in Rust too (Zod rejects a
  missing key); an explicit `null` is a value.
- One string-tagged branch may declare its tag optional; a value without the
  tag decodes as that branch (image artifact metadata written before `kind`).
- camelCase wire fields keep their spelling through `#[serde(rename)]`
  (`launchKind`). The `readOnly` keyword from `.readonly()` arrays is allowed.
- String literals outside tags decode into unit types (`LitOpenai`,
  `LitProject`, ...) and reject other values, matching Zod. The named
  `ProtocolVersion` literal stays a `String` so a mismatch can be reported.
  A value of a set that may grow is a single-value `z.enum` instead (open in
  Rust; TS types unchanged): `llm.status` provider and verification,
  `config.set` `applies`, subagent `context_mode`, model view `version` /
  `media_type`, document part `media_type`, completed `auth.login` `method`,
  `ModelSpeedTier`. Fixed markers that identify a shape (`scope: "project"` in
  `permissions.remove` branches, client tool `type: "function"`) stay literals.
- `model.ts` builds a type dependency graph of named definitions, aliases
  and inline schemas with reference, field, item, map-value and union-branch
  edges. The method params and results are the direction roots. The graph
  computes encode and decode reachability and propagates Serialize-only
  dependencies to their users. A live receive path that reaches an
  unsupported union or `wireCount()` fails generation with its method, slot
  and schema path. `rust.ts` consumes the graph decisions. Definition,
  method and fixture route sorting uses code-unit order.
- A nested tagged branch must share one outer tag value. Documentation
  keys such as `description` and `readOnly` do not stop `z.unknown()` from
  being treated as opaque.
- An open enum with a wire value `"unknown"` names its fallback `Other`.
- `ServerNotification` / `ServerRequest` gain `params()` for re-encoding.
- The generator also writes `packages/protocol/schema/methods.md`.
- Shared samples live in `tools/protocol-codegen/src/samples/` (one file per
  area) and include the `ui_to_runtime_notification` route.

- CI's image preview PTY test (`scripts/check-tui-image-preview.py`) fakes the
  runtime; its results and events follow the generated types.

Runtime:

- `parseRequestParams` reads omitted params as `{}` and names the first
  failing field in the INVALID_PARAMS message (`invalid X params: path:
  message`); `data.issues` is unchanged and never echoes input values.
- Params are parsed after each handler's existing gates (capability,
  availability, busy; `image.model.configure` after its busy gate). Handlers
  branch and reply on the parsed value. Strict request validation and the
  version-0 `model.set.reasoning` normalization are described in §8.
- `parseUiNotificationParams` validates `ui.context.update`; a malformed one is
  logged and dropped.
- Dialog replies (`ui.confirm/prompt/pick`) are validated; a reply that breaks
  the contract resolves to `null` (declined). `UiConfirmResult.remember` and
  `reason` are `nullish` because older TUIs send `null`.
- `image.model.configure` params list the fields the runtime accepts (Google
  size, ratio and output format); its result is the status with every field
  but `message` optional, since an unchanged setting returns only `message`.
- `task.spawn` results use `TaskInfo` (a summary is a valid `TaskInfo`), and
  `task.result` is `TaskInfo | null` (`null` while the task is not finished).
- Skills get wire-shape mirrors (`SkillMetadataWireSchema`, ...) of the
  validating shared-types schemas; a type assertion keeps them equal.

TUI:

- Every request is sent with `send_request` / `send_reply`; there is no
  hand-built JSON-RPC left. Results are decoded per `PendingRpcMatch`.
  `image.model.get` requires `requested_mode` and `state`.
  `image.model.configure` also accepts a message-only acknowledgement.
- The runtime history reader projects legacy non-object `tool_call.args`
  to `{ "_raw": ... }` before forwarding (a saved string `raw_args` takes
  precedence over re-encoding the legacy argument value). The catalog and
  TUI decoder require an object.
- Steer acknowledgements, live application and terminal fallback prefer
  client IDs scoped to their run. Without client IDs, application and
  terminal fallback use the confirmed server ID, then a unique unverified
  server ID for the run. A malformed acknowledgement pauses the submission
  and can retain its raw server ID for later reconciliation. An ambiguous
  unverified match leaves the affected submissions paused. See
  [TUI mid-run Steer](tui-run-steer.md#55-unconsumed-steer-reporting-and-queue-fallback).
- A live `steer_applied` that fails to decode pauses that run's in-flight
  steers, since one of them may already be applied. If its run id is missing
  or invalid, the active run is used. Core always sets the required
  `timestamp`.
- A runtime -> UI request that fails to decode is answered at once with that
  method's declined reply (`{ok:false}`, `{value:null}`, `{ids:[]}` or a client
  tool failure).
- Opt-in notifications the TUI does not request (`run.context.usage`,
  `task.progress`, `auth.login.status`) decode to empty output.
- A replayed `agent.event` that fails strict decoding is shown as one status
  line naming its event type; the legacy renderer is removed. A scan of stored
  run logs found no such events, so this covers damaged or foreign logs.
- Test fixtures were completed to the contract instead of relaxing decoding.
