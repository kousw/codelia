# Terminal-Bench Support Spec (Harbor + Headless Runner)

This document defines how Codelia will support reproducible Terminal-Bench runs.
It turns backlog item **B-029** into concrete implementation requirements.

---

## 0. Context (2026-02-23)

Current state in Codelia:

- `full-access` approval mode is implemented.
- Runtime is already a JSON-RPC stdio server (`packages/runtime`).
- TUI-first UX exists, but no benchmark-focused headless entrypoint exists yet.
- Terminal-Bench support is currently tracked only in `docs/specs/backlog.md` (B-029).

External baseline:

- Harbor documents Terminal-Bench 2.0 as `harbor run -d terminal-bench@2.0 ...` and uses Docker for local runs.
- Harbor docs define two integration styles for custom agents:
  - external agents (`BaseAgent`)
  - installed headless agents (`BaseInstalledAgent`) where run commands are typically one headless command.
- Harbor docs/RFC define ATIF as the trajectory exchange format and provide validator support.

---

## 1. Goals

1. Run Codelia against Terminal-Bench in a reproducible, unattended way.
2. Keep normal interactive usage (`minimal`/`trusted`) unchanged.
3. Produce benchmark artifacts that are machine-comparable across runs.
4. Export/validate trajectories in ATIF so Harbor-compatible tooling can consume them.

---

## 2. Non-goals (MVP)

1. Building a new benchmark harness (Harbor remains the harness).
2. Replacing Harbor’s built-in leaderboard submission flow.
3. Implementing every Harbor environment backend (Daytona/Modal/E2B) in MVP.
4. Full parity with every Harbor-integrated agent from day one.

---

## 3. Terminology and boundaries

1. `approval mode` (`minimal|trusted|full-access`) controls permission/confirm behavior only.
2. `sandbox backend` (Docker/nsjail/bwrap/etc.) controls isolation strength.
3. Terminal-Bench execution path must be separate from normal TUI interactive path.

This preserves existing separation in `docs/specs/approval-mode.md` and `docs/specs/sandbox-isolation.md`.

---

## 4. Required work items

### 4.1 Headless benchmark entrypoint

Add a benchmark-oriented entrypoint that does not require interactive TUI operations.

Requirements:

1. Accept one task instruction (or one run payload) and execute a full run autonomously.
2. Stream-safe behavior with deterministic completion output (success/failure + artifact paths).
3. Explicit flag/config for benchmark mode (no accidental activation in normal use).

Proposed surface (MVP direction):

- runtime-level mode first (e.g., bench runner module), then optional CLI wrapper command.

### 4.2 Harbor integration shape

Provide a Harbor-facing Codelia adapter path that supports headless invocation.

Requirements:

1. Support Harbor agent integration pattern where command execution is headless.
2. Make run command deterministic and non-interactive.
3. Ensure Codelia process exits with clear terminal status for Harbor trial accounting.

Notes:

- This can be implemented either as:
  - Harbor-side custom agent import that shells out to Codelia, or
  - Codelia-provided helper scripts/templates under a dedicated `tools/terminal-bench/` area.

### 4.3 Approval policy for unattended runs

Benchmark runs must be non-interactive and must not block on confirm UI.

Requirements:

1. Benchmark mode uses `full-access` by explicit configuration.
2. Explicit `deny` rules continue to apply.
3. Normal modes (`minimal`/`trusted`) remain default outside benchmark execution.
4. Logs/metadata must record resolved approval mode.

### 4.4 ATIF export and validation

Produce ATIF trajectory artifacts per run.

Requirements:

1. Export one ATIF trajectory file per benchmark trial (`trajectory.json` or equivalent).
2. Include minimum ATIF root fields: `schema_version`, `session_id`, `agent`, `steps`.
3. Preserve tool call / observation linkage (`tool_call_id` <-> `source_call_id`).
4. Include available metrics (tokens/cost/cache hit fields) when available.
5. Validate produced ATIF with Harbor validator-compatible checks before marking run successful.

Compatibility rule:

- ATIF version must be configurable and pinned in run metadata.
- If Harbor docs/RFC version wording diverges, Codelia follows validator compatibility, not prose examples.

### 4.5 Artifact contract

Define stable output layout for reproducibility and downstream analysis.

Required layout (Codelia-side logical contract):

- `<run_dir>/raw/` : raw runtime events/logs
- `<run_dir>/atif/trajectory.json` : ATIF trajectory output
- `<run_dir>/summary.json` : normalized summary (status, duration, usage, cost, model, approval mode)
- `<run_dir>/run-metadata.json` : benchmark metadata (see below)

`run-metadata.json` minimum fields:

1. `timestamp_utc`
2. `codelia_commit_sha`
3. `codelia_version` (if available)
4. `dataset_id` (e.g., `terminal-bench@2.0`)
5. `task_id` (if available)
6. `model_provider` / `model_name`
7. `approval_mode`
8. `sandbox_backend`
9. `atif_schema_version`
10. `exit_status`

### 4.6 Docker-local reproducibility path

MVP must support a local Docker-based execution path aligned with Harbor local behavior.

Requirements:

1. Document required host dependencies (Docker running, API keys, Harbor install).
2. Provide one-command local benchmark script for smoke runs.
3. Keep benchmark assets isolated from regular project workflow (dedicated directory).

### 4.7 Failure semantics and retry safety

Requirements:

1. Timeouts, agent crashes, and invalid ATIF must produce explicit non-zero outcomes.
2. Partial artifacts should still be preserved for debugging.
3. Retry should create a new run directory (no destructive overwrite by default).

---

## 5. Suggested repository layout (MVP)

```text
tools/terminal-bench/
  README.md
  scripts/
    run-local.sh
    run-harbor.sh
    validate-atif.sh
  configs/
    benchmark.example.env
    run.local.example.json
  adapters/
    (optional Harbor agent helper/template files)
```

Implementation note:

- Keep this area as orchestration glue; runtime logic remains in `packages/runtime`.

---

## 6. Protocol and runtime implications

1. Existing runtime JSON-RPC transport remains unchanged.
2. Benchmark mode should avoid UI-only RPC requirements (`ui.confirm.*`, pick/prompt UX).
3. Headless benchmark entry must not rely on TUI render/event loop behavior.
4. Session/run event persistence should be reused where possible to avoid duplicated logging logic.

---

## 7. Test and verification requirements

Minimum checks before considering Terminal-Bench support complete:

1. **Unit**: ATIF mapper/serializer validation tests (including tool-call linkage).
2. **Unit**: benchmark mode config resolution (`full-access`, paths, metadata generation).
3. **Integration**: one local Docker smoke trial (small sample) producing required artifacts.
4. **Regression**: no behavior change in normal TUI run flow.
5. **Docs**: runbook updated with exact commands.

---

## 8. Phased rollout

### Phase 1 (MVP)

1. Headless single-run entrypoint.
2. ATIF export + validation.
3. Local Docker smoke path with Harbor-compatible command flow.
4. Dedicated benchmark directory and scripts.

### Phase 2

1. Batch execution helpers and comparative summary tooling.
2. Better failure analytics and artifact indexing.
3. Optional cloud environment support playbooks.

### Phase 3

1. CI/nightly benchmark automation (opt-in).
2. Longitudinal trend reporting across commits/models.

---

## 9. Acceptance criteria

Terminal-Bench support is accepted when all are true:

1. Codelia can be run headlessly for benchmark tasks without interactive prompts.
2. Benchmark runs execute with explicit `full-access` mode and retain deny-rule enforcement.
3. Each trial emits required artifacts (`raw`, `atif`, `summary`, metadata).
4. ATIF output passes validator-compatible checks.
5. Local Docker path is documented and reproducible by another developer.
6. Existing TUI/interactive behavior remains unchanged.

---

## 10. Open questions

1. Final command UX: runtime-only runner vs new CLI subcommand (`codelia bench ...`).
2. Exact Harbor adapter ownership boundary (Codelia repo vs separate integration repo).
3. Which ATIF schema version to pin by default at first release.
4. Whether to include full prompt/token-id level details by default or behind an opt-in flag.

---

## 11. References

- `docs/specs/backlog.md` (B-029)
- `docs/specs/approval-mode.md`
- `docs/specs/sandbox-isolation.md`
- Harbor docs: Running Terminal-Bench (`harborframework.com/docs/datasets/running-tbench`)
- Harbor docs: Agents integration (`harborframework.com/docs/agents`)
- Harbor docs: ATIF overview (`harborframework.com/docs/agents/trajectory-format`)
- Harbor ATIF RFC (`github.com/laude-institute/harbor/.../docs/rfcs/0001-trajectory-format.md`)
