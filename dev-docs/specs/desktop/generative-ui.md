# Desktop Generative UI Spec

This document describes desktop support for rendering structured runtime-driven
UI inside the desktop client.

It now has a small implemented MVP plus a larger future direction centered on:

- semantic structured payloads
- an internal mini-model mapper
- a bounded desktop renderer

## 1. Purpose

Allow Codelia to present richer UI than plain transcript prose when a response
benefits from structured rendering.

Example outcomes:

- comparison tables
- KPI / status summaries
- compact charts
- simple flow/sequence-style diagrams
- class-diagram-ish structure maps for architecture reading
- option pickers or compact decision panels
- structured action surfaces
- result dashboards for repo/runtime inspection

The goal is not to replace normal chat.
The goal is to let the agent temporarily render a bounded UI surface when that
surface is more useful than markdown text alone.

## 2. Current MVP

Implemented today:

- desktop advertises `ui_capabilities.supports_generated_ui` at `initialize`
- runtime exposes a desktop-only `ui_render` tool when that capability is
  present during agent creation
- `ui_render` returns typed JSON payloads instead of raw HTML
- desktop detects those typed `tool_result` payloads and renders them as inline
  structured panels inside the transcript flow

Current limits:

- inline panel only
- no generated action handlers yet
- no separate `ui.render` event family yet
- transcript durability currently comes from the normal tool-result history

The desktop MVP intentionally does **not** change the shared system prompt.
Discovery is expected to come from the desktop-only tool definition and schema.

## 3. Core idea

The runtime should be able to emit a **structured UI payload** through a
desktop-aware tool or event.

Desktop should then:

- render that payload in a dedicated UI surface
- keep transcript history concise
- preserve reopen / inspect affordances
- avoid mixing arbitrary HTML into assistant prose

This should be treated as a separate rendering mode from markdown.

## 4. Preferred future architecture

The preferred longer-term architecture is:

`semantic structured payload -> mini model mapper -> bounded renderer`

This is different from the current MVP, where the main agent emits a desktop UI
spec directly through `ui_render`.

### 4.1 Why this is preferred

- the main agent should focus on meaning, not low-level UI node assembly
- UI quality should be improvable without changing the main agent prompt/tool
  behavior
- desktop should be able to change visual treatment without changing the
  semantic payload contract
- a mapper can iterate through draft, validate, and repair steps without
  polluting the user-visible session transcript

### 4.2 Layer responsibilities

- main agent: produce semantic structured payloads when prose alone is not the
  best presentation
- mapper: translate those semantic payloads into a bounded renderable UI spec
- renderer: render only allow-listed desktop primitives and known interaction
  handlers

The semantic payload is the durable meaning.
The mapped UI spec is a disposable presentation artifact.

## 5. Product model

### 5.1 User expectation

When the agent decides a structured view is useful, the desktop client may show:

- an inline panel within the transcript flow
- a docked auxiliary panel
- an inspect-style restorable surface

The transcript should still explain what happened in plain language.
The structured UI is a support surface, not an opaque replacement for the turn.

### 5.2 Appropriate use cases

Good fits:

- repo/package summaries
- grouped tool results that want table or card treatment
- model/runtime capability overviews
- side-by-side comparisons
- agent-generated “choose one” or “review these options” interfaces

Bad fits:

- replacing the entire chat transcript with generated layouts
- arbitrary marketing-like or decorative UI generation
- bypassing approvals or existing UI request semantics
- letting the model emit raw HTML/JS for direct execution

## 6. Rendering boundary

Desktop should treat this as a **guardrailed structured UI runtime**, not as
HTML injection.

The expected model is:

- runtime emits a typed semantic payload or typed UI spec
- desktop renders only allow-listed components
- user actions from that UI map to explicit desktop/runtime actions

The JSON payload should not be trusted as executable code.

## 7. Semantic payload model

The future main-agent output should prefer semantic payload kinds such as:

- comparison
- key_value_summary
- review_panel
- decision_options
- entity_graph
- metric_series
- report_sections

Each semantic payload should describe meaning and relationships, not desktop
layout details.

Examples of semantic content:

- entities and relation kinds for architecture maps
- metrics and labels for charts
- rows/columns with semantic roles for comparison tables
- grouped options with recommendation metadata for review/choice surfaces

The semantic payload should stay valid even if the desktop visual language
changes.

## 8. Mapper model

The mapper should run as an internal ephemeral workflow, not as a normal user
session.

Preferred shape:

- same runtime process
- no durable session persistence
- no normal transcript projection
- short-lived scratch history only for one mapping job
- strict iteration cap for `draft -> validate -> repair`

If the mapper only needs one pass, a direct `BaseChatModel` call may be enough.
If it needs iterative `create -> validate -> repair`, a private mini agent is a
better fit.

The first preferred mapper profile is:

- fast model
- narrow prompt
- rendering-only private tool set

## 9. Required runtime capabilities

The semantic-payload architecture implies a few runtime capabilities that do not
fully exist yet.

### 9.1 LLM factory extraction

Runtime should factor provider/model construction so both the main agent and the
mapper can reuse the same low-level LLM creation path without duplicating
provider logic.

### 9.2 Ephemeral workflow runner

Runtime should support an internal workflow runner for short-lived private jobs
that:

- do not append to normal session history
- do not become user-visible transcript turns by default
- can still produce diagnostics and bounded failures

### 9.3 Private rendering tools

The mapper should not receive general runtime tools.

Instead it should receive only rendering-internal tools such as:

- `ui_schema_validate`
- `ui_schema_repair_hint`
- optional `ui_catalog_lookup`

These tools must stay internal to runtime and should not appear in the normal
agent tool catalog.

### 9.4 Renderer contract versioning

Desktop and runtime need a versioned bounded renderer contract so the mapper can
target a known catalog safely.

### 9.5 Fallback path

If mapping fails, desktop should still have a deterministic fallback:

- render a plain structured view from the semantic payload
- or fall back to transcript prose plus inspectable raw structured data

## 10. Relationship to `json-render`

One viable future implementation is a `json-render`-style model:

- runtime-side mapper produces a JSON UI spec
- desktop owns the component registry and rendering surface
- the model can only request components/actions that desktop explicitly allows

This is a better fit than using `json-render` as a generic transcript JSON
viewer.

Recommended interpretation:

- `json-render` is a candidate presentation substrate for **generated
  structured UI**
- it is not the primary answer to markdown, transcript prose, or raw JSON logs
- if adopted, it should sit after the semantic payload stage rather than
  replacing the semantic payload contract itself

## 11. Current payload shape

The current MVP uses a typed `tool_result` JSON payload.

Current payload expectations:

- payload kind is `generated_ui`
- version is explicit
- surface is currently `inline_panel`
- payload carries a small allow-listed node catalog
- desktop should reject unknown shapes rather than partially trusting them

The UI should still avoid depending on assistant prose parsing.
The structured meaning comes from the typed tool-result body.

This MVP should be treated as a pragmatic bootstrap, not as the final
architecture contract.

## 12. Future protocol shape

Preferred future direction:

- runtime emits a future event or tool family such as `ui.render`
- the payload includes:
  - `surface_id`
  - `surface_kind`
  - `title`
  - structured UI spec
  - optional action descriptors
  - optional persistence / reopen hints

This would let generated UI stop piggybacking on generic tool-result display
while still keeping runtime authority centralized.

## 13. Surface placement rules

### 13.1 Inline surface

Use inline placement when the rendered UI is tightly coupled to one assistant
turn and is small enough to remain readable in the chat flow.

Examples:

- comparison table
- review checklist
- option picker

### 13.2 Auxiliary surface

Use an auxiliary panel or inspect-style panel when the UI:

- is tall or dense
- benefits from repeated reopening
- includes interaction beyond a lightweight review

Examples:

- repo overview dashboard
- larger inspection surface
- multi-section generated report

## 14. Transcript behavior

Transcript should keep a compact record even when structured UI is shown.

Expected transcript behavior:

- show a plain-language assistant explanation
- show a compact record that a structured surface was rendered
- allow reopening or focusing the rendered surface later
- avoid dumping the entire structured spec into the visible transcript

The transcript remains the durable narrative.
The generated surface is a companion view.

The current MVP satisfies this by rendering the inline panel directly from the
typed tool-result payload while assistant prose remains visible as normal chat
content.

In the preferred future architecture, transcript durability should come from the
semantic payload and the assistant narrative, not from preserving every
intermediate mapper draft.

## 15. Action model

Generated UI may expose user actions, but those actions must remain bounded.

Allowed direction:

- actions map to explicit desktop/runtime intents
- action ids are validated against a known allow-list
- sensitive actions still respect existing approval policy

Disallowed direction:

- arbitrary shell execution from generated UI
- hidden side effects not visible in transcript/runtime state
- action handlers defined purely by model-supplied code

The current MVP does not expose generated UI actions yet.

Future generated UI actions should still be emitted from bounded renderer
contracts, not from model-supplied code.

## 16. State and persistence

Desktop-owned transient state may include:

- whether a generated surface is expanded
- whether it is pinned to the auxiliary panel
- local reopen/focus state

Runtime-owned durable state may include:

- the fact that a renderable structured surface was produced
- the structured spec or a reference to it
- user selections/results when they are semantically part of the run/session

Desktop should not silently become the only durable holder of structured UI
content that matters to session history.

The current MVP keeps semantic durability in normal session/tool history and
desktop-only fold/open state in local transient UI state.

The preferred future shape is:

- semantic payload: durable
- mapped UI spec: ephemeral or re-derivable
- desktop expansion/focus state: transient
- user actions/results with semantic meaning: durable

## 17. Validation and repair loop

Generated UI should be allowed a bounded internal validation loop.

Expected flow:

1. main agent emits semantic payload
2. mapper drafts a bounded UI spec
3. validator checks schema/catalog/layout constraints
4. mapper repairs if needed
5. desktop renders final validated spec

The loop should be short and deterministic enough to avoid feeling like a
second full agent run.

## 18. MVP component catalog

The first shipped catalog should stay very small.

Suggested initial set:

- `Text`
- `Heading`
- `Badge`
- `KeyValueList`
- `Table`
- `BarChart`
- `FlowDiagram`
- `Code`
- `Group`

Do not start the MVP with:

- arbitrary layout primitives
- custom theming from model output
- free-form navigation/routing
- complex form semantics

## 19. Tool-definition guidance

The desktop-only `ui_render` tool should carry most of its usage guidance in
the tool description/schema rather than in prompt text.

The description should make these rules explicit:

- use it only when structure is materially clearer than prose
- keep it supplemental to normal assistant explanation
- keep labels and text concise
- do not use it for decorative layout
- do not assume arbitrary HTML/JS execution

When the semantic-payload architecture is introduced, those same rules should
move to:

- the semantic payload description/schema
- the mapper contract
- the renderer catalog contract

not back into prompt text.

## 20. Non-goals

- arbitrary HTML/JS execution in desktop
- replacing the transcript with generated UI
- treating generated UI as the default answer format
- bundling a huge general-purpose viewer just to pretty-print tool JSON
- giving the mapper normal repo/tool authority unrelated to presentation
- storing mapper scratch iterations as normal durable user session history

## 21. Open questions

- when to graduate from typed `tool_result` payloads to a dedicated `ui.render`
  event family
- how much of the mapped UI spec should be persisted vs regenerated
- whether generated UI actions should round-trip through existing `ui.request`
  flows or a separate interaction channel
- when auxiliary-panel placement should join the inline MVP
- whether the first mapper should be deterministic-first, mini-model-first, or
  hybrid
