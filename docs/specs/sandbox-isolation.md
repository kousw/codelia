# Sandbox Isolation Spec (worker execution security)

This document organizes sandbox security techniques for worker execution of `agentic-web` and defines decision-making criteria for subsequent implementations.
The main focus is to ``design the consistency of session separation (operation) and cross-border access prevention (security) separately.''

---

## 0. Background

With `basic-web` / `agentic-web`, run is executed on a worker process.
The following are currently installed:

1. Sandbox directory separation for each session
2. TTL cleanup of sandbox directory
3. Priority execution of the same worker using session sticky lease

On the other hand, as long as the `bash` tool is executed as is, it cannot completely prevent "references to other directories within the same worker" because there is no OS level isolation.

---

## 1. Purpose

1. Prevent session cross-border file references/updates at the OS level
2. Maintain worker residency model and keep run startup delay within practical range
3. Show practical solutions that can be implemented on Linux while maintaining platform-agnostic

---

## 2. Non-purpose

1. Complete isolation guarantees against arbitrary code execution (equivalent to microVM) are not immediately achieved.
2. Don't force the same isolation mechanism on all platforms
3. Do not completely re-create the existing run queue/lease model

---

## 3. Threat model

### 3.1 Target to protect

1. Session A's work files cannot be read or written from session B.
2. Confidential files (env, secret mount, other workspace) on the host cannot be viewed
3. Reducing worker interference due to excessive CPU/memory/process creation

### 3.2 Assumed attack

1. Moving `..` via `bash`, absolute path references, symbolic link abuse
2. Information acquisition via `/proc` / `/sys` / `/dev`
3. Resource exhaustion due to fork bombs and huge output

---

## 4. Requirements

### 4.1 Security Requirements

1. Limit the visibility of the root filesystem when running run to session sandbox + minimum runtime
2. Prohibit writing outside the session sandbox
3. Delete capabilities that lead to privilege escalation
4. If possible, disable networking by default (allow only when necessary)

### 4.2 Performance Requirements

1. Assuming worker residency
2. Keep the isolation setup delay for each run within an acceptable range (estimate: tens of ms to hundreds of ms) using p95.
3. Keep startup times short enough for DB lease renewal intervals

### 4.3 Operational Requirements

1. Can be reproduced with local development
2. Has a route applicable to docker/k8s/VM
3. Phased introduction/rollback possible with feature flag

---

## 5. Comparison of candidate methods

| Method | Separation strength | Execution overhead | Difficulty of implementation | Remarks |
|---|---|---:|---:|---|
| App layer path guard only | Low | Low | Low | `bash` When used together, border crossing prevention is insufficient |
| `bubblewrap` (`bwrap`) | Medium to High | Low to Medium | Medium | Realistic on Linux. mount/ns separation by run |
| `nsjail` | High | Medium | Medium to high | Easy to control including seccomp/cgroup |
| Separate container for each run | High | Medium to high | High | Increased startup cost/operational complexity |
| microVM (Firecracker, etc.) | Very high | High | Very high | Not initially covered by this spec |

---

## 6. Recommended policy (phased introduction)

### Phase A: Recent safe default

1. Disallow raw `bash` execution in `prod` (or explicitly opt-in)
2. Require via isolated runner even when allowing `bash`
3. Continue to use existing session-dir + TTL + sticky

### Phase B: Run unit `bwrap` Isolation (first candidate)

1. Launch `bwrap` child processes for each run
2. Writable mount only session dir
3. `/proc` is read-only in minimal configuration
4. Default `--unshare-net` (cancel with flag if necessary)
5. Enable capability drop / `no_new_privs`

### Phase C: `nsjail` Profile (enhancement options)

1. Combine seccomp/cgroup constraints to enforce resource limits
2. Evaluate default candidates for high security profiles

### Phase D: Separate container for each run (high isolation mode)

1. Make it selectable for multi-tenant and highly confidential applications
2. Adopt only in environments where startup time and operating costs are acceptable.

---

## 7. Draft implementation profile

### 7.1 Mode

- `logical` (close to current, for development)
- `bwrap` (recommended)
- `nsjail` (enhanced)
- `container` (high isolation)

### 7.2 Configuration key proposal

- `CODELIA_SANDBOX_MODE`
- `CODELIA_SANDBOX_ROOT`
- `CODELIA_SANDBOX_TTL_SECONDS`
- `CODELIA_SANDBOX_NETWORK` (`disabled` / `enabled`)
- `CODELIA_SANDBOX_CPU_LIMIT`
- `CODELIA_SANDBOX_MEMORY_LIMIT_MB`

Note: Key names may be adjusted in final implementation.

---

## 8. `bwrap` Execution image (concept)

```bash
bwrap \
  --die-with-parent \
  --new-session \
  --unshare-all \
  --unshare-net \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --proc /proc \
  --dev /dev \
  --bind "$SESSION_DIR" /workspace \
  --chdir /workspace \
  env -i PATH=/usr/bin:/bin sh -lc "$COMMAND"
```

This example assumes a configuration that does not allow writing to anything other than `/workspace` (= session dir).

---

## 9. Observability/Audit

1. Record `sandbox_mode`, `worker_id`, `session_id`, `sandbox_root`, `exit_code` for each run
2. Rejection events (policy violations) are recorded as dedicated event types.
3. Metrics of TTL cleanup count and failure count

---

## 10. Acceptance conditions

1. Session A cannot read session B's working directory
2. Writing outside the sandbox is denied
3. Run execution works within acceptable delay even when isolation is enabled
4. Run consistency is maintained even in worker restarts and multiple worker environments

---

## 11. Unresolved issues

1. Should you cut network permissions by tool or by run?
2. How to ensure the same policy for `read/write/edit` and `bash`
3. Equivalent means in non-Linux environments (tolerance of differences in development experience)

---

## 12. Related specifications

- `docs/specs/agentic-web.md`
- `docs/specs/permissions.md`
- `docs/specs/tools.md`
