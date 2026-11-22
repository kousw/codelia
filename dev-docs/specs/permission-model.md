# One-time permission requests

**Status.** The local parent shell supports workspace opt-in for confined commands and one-command write access to additional existing directories. Network requests, retries bound to an observed denial and one-command removal of isolation are proposed extensions. The [current runtime contract](./command-approval-and-auto-review.md) describes what ships today.

## Actors and authority

The user selects a sandbox and can correct the task or decide a pending confirmation. The parent agent may request additional authority and explain why it needs it. A child can operate only within its delegation. The host supplies a ceiling, protected paths and an executor. The runtime resolves and enforces the effective scope, consumes a decision once and records the outcome. A reviewer can return a decision about the bound request; it cannot edit the command or enlarge its scope.

The following sources constrain a request, in descending order:

1. Host ceilings, mandatory isolation and explicit denies.
2. The selected sandbox mode.
3. User-owned permission rules, project trust, private paths and remembered tool allowances.
4. Shared project allows where the user trusts this project, including inherited legacy trust.
5. Original user instructions and applied Steers, as evidence of consent to a particular effect.

Assistant explanations, quoted instructions, tool output, attachments, web content and untrusted repository settings confer no authority.

## What a request can grant

| Request | Policy |
| --- | --- |
| Write in the selected scope | Already delegated. Under `workspace-write`, this includes editing and deleting ordinary workspace files. Both confined modes allow writes in private scratch space. |
| Write outside the current grant but within the host ceiling | In `workspace-write`, the local parent shell can request existing directories with `additional_write_roots` for one command. Local TUI grants exclude directories that overlap the running installation or MXC launcher. Eligible requests go to the configured Auto approve reviewer when active, or to interactive confirmation when review is off. A `readonly` shell cannot request extra write roots. Built-in file tools retain their workspace limits. |
| Write to Git metadata, project `.codelia/`, runtime storage or a designated protected path while confined | Reject before confirmation. |
| Connect to a named destination | Require a destination-limited proxy and OS enforcement against direct connections. Review the requested destination and each redirect separately. |
| Lift isolation for one command | If the host permits this, show the full effective filesystem and network access of the login user and require a human decision. Otherwise reject. |
| Exceed the host ceiling, override a deny, or escalate from a child | Reject and return the reason. |

A session explicitly started in `full-access` follows its existing startup approval policy. Selective grants and one-time removal of isolation are distinct requests. Confined subprocesses inherit the OS boundary. [macOS backend](../../packages/runtime/src/permissions/shell-backend.ts) · [Linux backend](../../packages/runtime/src/permissions/linux-shell-backend.ts)

## Invariants

| ID | Requirement |
| --- | --- |
| I1 | Apply explicit denies, host ceilings and mandatory isolation before consulting a person or reviewer. |
| I2 | Only trusted sources of authority listed above can establish consent. |
| I3 | Require a grant for effects outside the delegated scope. Account for existing writable hard-link aliases, including shared Git objects in a local macOS clone. |
| I4 | Bind approval to a scope the executor can enforce. If a broader release is necessary, display its actual scope and require a human decision. |
| I5 | Bind a one-use grant to the request, command, cwd, effective authority and intent revision. Substitution, revocation, Steer or cancellation invalidates it. Restore the original sandbox for the next command. |
| I6 | Workspace edits are live. An agent can destroy uncommitted changes. Git history protects committed content subject to the documented shared-object exception. |
| I7 | A failed or timed-out review cannot start the command. Return the diagnostic and use human confirmation where available. |

## Request and retry sequence

1. Start in the current sandbox after mandatory checks. In explicit confirmation mode, continue to honor the built-in read rules, active allows and human confirmation. Workspace Auto approve admits an eligible confined parent launch locally.
2. If a destination is known in advance, the agent may request it before launch. After a permission failure, bind the request to the runtime's record of the failed operation. Include the exact command and cwd for the new launch, the requested target and the agent's explanation.
3. Check the requested grant against the host ceiling and the executor's effective restrictions. For automatic network review, require a destination the runtime can resolve from the invocation or a destination the proxy recorded as blocked for that specific attempt. Otherwise ask the user. A generic exit code alone cannot establish a permission failure.
4. Retry only the failed step. For example, if generation succeeded and dependency retrieval failed, retry retrieval. Inspect state first when partial effects are unknown. If the step cannot be separated and repetition could duplicate effects, show the impact and ask the user.
5. Validate the decision immediately before use and consume it once. An existing command-prefix allowance cannot grant a destination, an additional write root or unconfined execution.

### Review outcomes

| Outcome | Interactive local TUI | Headless |
| --- | --- | --- |
| `allow_once` | Execute once in the approved scope. | Same. |
| `deny` | Notify the user in one line, give the reason to the agent, and allow work on the remaining task. Instruct the agent to respect the denial across alternative tools. | Return the reason. |
| `insufficient_evidence` or `ask_user` | Show the unresolved question and request a decision. | Return the reason. |
| Review failure or timeout | Show the diagnostic and request a human decision. | Keep the command unstarted and return the diagnostic. |

The proposed repeated-denial policy switches subsequent requests to human confirmation after three consecutive denials in a run or twenty total in a session. In headless mode, stop the run and report why. Human approval resets the consecutive count. Replaying the same request must not trigger another model review. [Existing decision binding](../../packages/runtime/src/permissions/dispatch.ts)

A proposed history view (working name `/approvals`) lists the last ten denials. A user can allow one original request once. On resubmission, consume that grant only if the original bindings still match. Deliver the notice at a Steer boundary without treating it as a new user instruction. New intent, Steer and changed bindings invalidate the grant.

## Evidence and consent

Use original user text and applied corrections, the command and its analysis, cwd and effective authority. Add the requested grant type and target, runtime-resolved destination and any associated proxy denial. Label the agent's explanation as `agent_explanation`. Keep assistant narration, tool output, attachment bodies and environment values out of the packet. When the evidence contains a secret, keep it local and request human confirmation. [Current evidence builder](../../packages/runtime/src/permissions/review-evidence.ts)

Judge the actual effect: destination, data sent, shared state changed, reversibility and relation to the user's request. A configured Git remote or registry identifies an endpoint. Authorization depends on what the operation will do there.

| User instruction | Requested effect | Expected outcome |
| --- | --- | --- |
| Run the tests | Fetch a necessary dependency from the default registry | Allow once |
| Run the tests | Publish to that same registry | Deny |
| Publish this package | Publish it to that registry | Allow once |
| Run the tests | Fetch from a registry supplied only by an untrusted repository setting | Ask the user locally |
| Inspect the diff | Push to origin | Deny |
| Push this branch to origin | Ordinary push of the named branch to origin | Allow once |

A request to build or test can imply consent to necessary dependency retrieval from a default, user-configured or trusted project registry. Repository settings such as `.npmrc` can redirect authenticated requests; require human confirmation for a registry supplied only by untrusted settings. Sending data, modifying a shared service, publishing or weakening access controls requires instructions identifying the operation and target.

### Resolving destinations before launch

| Invocation | Source of candidate destination |
| --- | --- |
| Git push, fetch, pull or clone | URL argument, or read-only resolution of the remote name from Git configuration |
| npm, pnpm, Yarn or Bun install/publish | Configured or default registry |
| Cargo fetch, build or publish | Cargo registry configuration or default |
| pip install, uv sync, Poetry install | Configured or default index |
| curl or wget | Explicit URL |
| gh | Configured GitHub host |

For registry and index configuration, automatic review trusts user-owned or trusted-project settings. Other invocations may use a destination observed in a bound proxy denial. Resolving a destination does not authorize the transfer.

## Evaluation and rollout

The proposed request-only reviewer uses an effect-based prompt and default `medium` reasoning effort. Consider a second review stage if evaluation reveals excessive false blocks. For each registered reviewer, test direct consent, ambiguity, absent and withdrawn consent, instructions quoted in untrusted material, unrelated destinations and uploads presented as downloads. Use paired cases with identical destinations. Initial targets are zero approvals of explicitly forbidden operations, at most 5% approvals of unauthorized transfers or shared-state changes, and at most 15% denials of authorized requests. These are evaluation targets. [Existing evaluation (Japanese)](./command-approval-reference.ja.md#オフライン評価) · [Current reviewer instructions](../../packages/runtime/src/permissions/public-reviewer.ts)

| Stage | Delivery |
| --- | --- |
| 1 · Implemented | Enable confined parent launches per workspace without a reviewer call. |
| 2 · Partial | The parent shell supports one-command directory write grants with human confirmation or Auto approve review. General escalation requests across tools and transports remain proposed. |
| 3–4 · Proposed | Evaluate the new prompt and paired cases. Add denial notifications, repeated-denial handling and one-use human overrides. |
| 5–6 · Proposed | Introduce the destination-limited proxy and enable automatic network review for qualified models. Bind retries to observed write denials in addition to the existing up-front directory requests. |

The design draws on Codex's sandbox-first launches and destination checks, and Claude Code's assessment of effects and direct user consent. It retains Codelia's local secret checks, revocation and one-use enforcement.

## Residual risks

- Uncommitted and untracked content can be lost. A prior commit, `readonly` or a [separate worktree](./lane-multiplexer.md) changes the user's exposure. Snapshot rollback is future work.
- Editable scripts, makefiles, `.envrc`, CI configurations and editor tasks can run later outside the sandbox.
- A destination-limited proxy cannot inspect encrypted HTTPS content. A process allowed to fetch dependencies could send an upload to the same endpoint, potentially using credentials readable in the sandbox. Operators can designate private paths.
- An existing writable hard-link alias may expose changes outside the workspace. The macOS shared-clone exception also applies to Git objects. [Current protections](./command-approval-and-auto-review.md#what-the-sandbox-protects)
- A mistaken review can cause external effects within the destination and one-use scope actually granted.
