# Tool approval and local execution

[日本語ガイド：サンドボックス・コマンド承認・Auto approve・旧 trusted からの移行](./command-approval.ja.md)

Codelia checks the registered tool, its operands and its authority before it executes. Ordinary reads and task lookups use local checks. A launch that needs consent presents a structured choice. Headless clients receive `confirmation_required` when consent is needed.

## Shell execution

The runtime submits the original shell program once. The native launcher uses Bash on macOS and Linux, and system PowerShell for Windows full access. The investigation profile can read ordinary local files and write to private scratch space. The development profile also allows writes in the approved workspace. Both confined profiles block direct network access. Selecting `--sandbox-mode full-access` explicitly disables OS isolation for approved local commands. The process and its descendants run with the current user’s filesystem and network access. The runtime rejects a launch when its selected backend cannot enforce the requested profile.

### Running one command outside the sandbox

Some steps cannot work inside `readonly` or `workspace-write`: for example `gh` needs the network and your login state, and confined shells have no direct network, cannot reach host services such as credential agents, and cannot write outside the workspace. When a confined command fails for that reason, the agent can request the same step again with `escalation: "unsandboxed"`. That one command and its descendants then run as your user with your files, credentials, environment and network; the next command uses the sandbox again.

Each escalation is decided once and never saved: no remembered command, configured allow, or workspace Auto approve confined auto-launch covers it. When Auto approve is off, in `readonly` mode, when user `protected_paths` are configured, or for destructive/unparseable commands, you always decide in a dialog titled **Approve unsandboxed shell?** with **Run once (unsandboxed)**. In `workspace-write` with an active Auto approve reviewer model (and no user `protected_paths`), eligible parsed non-destructive escalations route through Auto Review, which can perform bounded in-process read-only workspace inspection (`read_file`, `list_dir`, `grep` respecting privacy/protected paths with TOCTOU re-verification before launch) and falls back to the human dialog if the reviewer declines, is inconclusive, or fails. Deny rules still apply first. Child agents, interactive stdin, `additional_write_roots` and SDK hosts that supply custom shell/approval adapters or operator protected paths cannot escalate. A failed confined command reports its sandbox in the tool result when escalation is available so the agent can tell when escalation may help.

The development grant includes ordinary files already linked into the workspace. An in-place update is visible through their existing hard links, including links outside the workspace. The native macOS backend blocks new external hard links and writes through external symlinks. Codelia checks explicitly private paths and protected control files for existing hard-link aliases. It rejects native launches when these aliases prevent containment.

### Local Git operations

In `workspace-write`, a confined development command on the local TUI host using a backend that can deny absent paths inside writable directories (currently macOS Seatbelt and MXC) can run ordinary local Git operations such as `git add`, `git commit`, `git switch` and `git stash`. Only a repository rooted directly at the workspace (`.git` directory or verified linked worktree `.git` file, never a parent repository or nested subdirectory `.git` pointer) opens its Git directory — and for a verified linked worktree, its metadata and the common directory outside the workspace — for that command. Entries that could redirect Git or run code in a later Git command outside the sandbox stay read-only, including ones that do not exist yet, multi-hop symlink chains and targets referenced by `include.path`, `includeIf.*.path` or `core.hooksPath` in existing config files: `config`, `config.worktree`, `hooks/`, `commondir`, `gitdir`, `objects/info/alternates`, `remotes/`, `branches/`, `modules/`, `rebase-merge/`, `rebase-apply/`, `sequencer/`, existing linked-worktree pointers and a linked worktree's own `.git` file. Unparseable config files or symlink cycles fail closed and keep the whole `.git` directory read-only. Operations that need protected entries (changing configuration, `git rebase`, `git push -u`, setting upstream branches, submodules), network Git operations and commit signing that needs an agent socket still need [escalation](#running-one-command-outside-the-sandbox). Branches and history are no longer protected by the sandbox on those backends: a confined command can move or delete refs. Built-in file tools, SDK hosts without explicit opt-in, and backends without absent-path denial (such as Linux gVisor) keep the whole Git directory read-only, so local Git commits there use [escalation](#running-one-command-outside-the-sandbox).

Confined shells can allocate pseudo-terminals for tests that need a TTY. On macOS only terminals created inside the sandbox are readable and writable; existing terminals accept terminal control calls only.

The standard local macOS development shell can run tests in a local Git clone that shares objects with its source repository. An in-place shell edit through an existing writable alias of a shared Git file can affect both repositories. Built-in file tools check their specific target and reject writes to aliases of Git metadata. The shell uses stricter checks for additional write roots and overlapping protected paths.

Ordinary local files, including user-readable credential files, are readable by default. To make a file or directory private in confined modes, add its absolute path to `default.protected_paths` in the user-owned `projects.json`. A workspace entry in `projects` can add more paths with its own `protected_paths` array. Restart the local runtime after editing this file. Explicit full-access shells run outside the local privacy profile. These entries combine in confined modes with the SDK host's explicit `approvalProtectedPaths`. Git metadata and Codelia authority settings have separate write protections.

When the workspace is the home directory itself, ordinary files and folders remain writable in `workspace-write` (on Linux gVisor, `~` itself is mounted read-only while existing ordinary children are bind-mounted writable, so creating brand-new top-level entries directly in `~` requires an existing subdirectory), while top-level dot-entries (`~/.*`, existing and future) and macOS `~/Library` are read-only by default across confined shells and built-in file tools (protecting shell profiles, SSH keys, and global package manager stores such as `~/.npm-global`, `~/.bun`, `~/.nvm`, and `~/Library/pnpm`). Built-in `write`/`edit` tools keep home dot-entries read-only; shell commands can request write access to an existing external or home dot-directory via `additional_write_roots` (directory-scoped, not single dotfiles like `~/.zshrc`). The local runtime can read and save workspace-scoped settings (sandbox mode, Auto approve, and remembered tools) in its owner-verified default user storage inside that directory, while rejecting redirects, unsafe permissions, and checkout-owned paths. When the workspace's `.codelia/config.json` resolves to the same file as the global `config.json`, Codelia reads it once as global config and requires explicit `global` scope for config writes.

In a confined Linux shell, writing through an ordinary home symlink uses the target's permissions. A link to a writable workspace directory works with the existing grant. A link to an external directory needs its own write grant, and a protected target keeps its restrictions. Codelia also reserves the future destination of a dangling home dot-link when it can resolve that destination. A cycle contained in direct protected home entries leaves ordinary workspace writes available. If Codelia cannot resolve a protected link or establish that kind of cycle, it may stop operations that need a workspace write grant.

Commands use the launching environment’s `PATH` or the SDK host’s explicit `RuntimeHostAdapters.shellPath`. Saved shell rules also bind the executable they authorize and the entire `PATH`. Activating `direnv` or `nix develop` can therefore require a fresh approval. Immediate inspection shortcuts use the OS command locations. Homebrew and Nix commands go through ordinary approval when their executable does not resolve there. Confined POSIX commands use your login `HOME`, which stays read-only outside existing grants, so global Git identity, ignores and tool configuration apply; `TMPDIR` and `XDG_CACHE_HOME` point to private scratch space. A tool that writes elsewhere in your home directory fails inside the sandbox. Existing absolute `CARGO_HOME` and `RUSTUP_HOME` directories, or the usual directories under the launching user's home when the variables are unset, are available under the same filesystem policy. Full-access shells also honor explicitly configured existing absolute Rust directories. With those variables unset, Rust uses the login home. Offline Cargo builds need locally available dependencies and may need a writable workspace cache if an operation has to update the registry cache.

Selecting `workspace-write` grants ordinary workspace writes at startup. A human can save a single external invocation for the session or project. The dialog shows the executable and whether the rule covers exact arguments or a prefix with any trailing arguments. A saved `cargo test` prefix covers `cargo test --release` with the same workspace, working directory, caller and confined authority. User-installed tools with multiple hard links, including rustup proxies, can use saved and handwritten allowances when the runtime can verify all links in the same installation directory outside writable and hidden paths. If a link is elsewhere or cannot be accounted for, the command goes through ordinary approval. Existing exact rules retain their original scope. Project code can change between runs. Compound programs and extra resources require their own decision.

In the TUI, use `/permissions list` to inspect saved rules and `/permissions remove` to revoke one. `/permissions run cargo test` submits the command as the operator and executes it once if approved. A rule saved there applies to operator requests. To save a rule for the agent, choose the save option on the agent’s confirmation dialog.

The Bash analyzer supports literal commands, pipelines, conditionals and finite loops over literal values. It examines the whole program before launch. For example, a loop that reads two files can use the built-in read permission for both with zero prompts and zero model calls. An applicable deny rule that cannot be evaluated prevents launch, including when Auto approve is enabled.

The native macOS launcher uses Seatbelt. Linux also requires a compatible rootless gVisor `runsc bwrap` installation and supported mount layout. Native tests cover existing protected paths. An absent protected path can make the confined shell unavailable. Creating, moving and deleting files with built-in tools also require a usable directory-mutation backend. Windows ProcessContainer is under native qualification. Windows ACLs can grant access beyond requested paths, including host-local IPC. Unqualified hosts require an appropriate SDK backend for confined shell launches. Unsupported isolation fails before launch. Explicit `full-access` selects login-user execution separately.

## Existing settings

At startup the runtime resolves the sandbox mode from the CLI, environment, project entry or default entry in the user-owned `projects.json`, in that order. Use `--sandbox-mode`, `CODELIA_SANDBOX_MODE` or `sandbox_mode` in the store. The default is `workspace-write`. At each layer the new spelling takes priority. Legacy `minimal` selects `readonly` and `trusted` selects `workspace-write`. Legacy `full-access` starts in `workspace-write` with instructions for selecting unrestricted execution explicitly. Existing deny rules apply immediately. Existing `permissions.allow` entries work in the local runtime. For example, `{"tool":"shell","command":"cargo test"}` matches a single bound invocation of `cargo test` with optional trailing arguments. Rules in a verified user-owned personal config apply across projects. Shared `.codelia/config.json` rules are active when the user already selected legacy `trusted` at the applicable scope. For a new project, use `/permissions trust` to inspect the rules and trust future edits for that workspace. `/permissions untrust` overrides inherited trust, and `/permissions list` reports the current state. Simply selecting the new `workspace-write` sandbox does not grant project trust. On hosts without ownership verification, including native Windows, the local UI can show the status but cannot persist a trust change.

A user can remember an eligible built-in tool such as `webfetch` for this workspace in the confirmation dialog. The local runtime stores tool-only rules in the user's `projects.json` under `projects[workspace].remembered_tool_allows`. These personal decisions apply independently of trust in the shared config. Inspect them with `/permissions list` and revoke one with `/permissions remove`. File-write authority and paid image or decision calls retain their own checks.

The management API lists stored launch rules with `permissions.list`. Use `permissions.remove` with the listed `launch_rule_id` and `scope` to revoke a rule. The same method accepts `{ "resource": "workspace_write", "scope": "session" }` to revoke a workspace write grant. Revocation invalidates pending approvals. Already running processes retain the limits applied at launch and can be stopped with the task controls.

## Auto approve

Auto approve starts off in each workspace. In `/auto-approve`, choose **Enable in this workspace** to turn it on without picking a reviewer. **Follow chat provider** and **Custom model** also enable it here and update the reviewer preference. `/auto-approve status` shows the workspace setting and reviewer availability. `/auto-approve off` returns this workspace to explicit confirmation. An old global reviewer preference does not enable another workspace.

With Auto approve on, the local parent shell can run an unregistered command once in the existing `readonly` or `workspace-write` sandbox without a prompt or model call. The runtime applies deny rules, checks the host ceiling, and stops before launch if a relevant deny cannot be evaluated or isolation cannot be enforced. OS network restrictions still apply. Shell requests with `additional_write_roots` (outside the workspace or targeting a home dot-directory, excluding Codelia’s config and credentials and directories that overlap the running installation or MXC launcher) are reviewed by the configured Auto approve model when active and fall back to human confirmation otherwise. Interactive stdin and `full-access` retain explicit confirmation.

Choose **Set up future allowance** in a shell confirmation to request a rule suggestion. If the suggestion is unavailable and the bound command is eligible, the runtime offers a local exact match. The confirmation shows the command and scope. The runtime saves the rule only after the user chooses a save scope. Added authorities and composite shell programs are outside this workflow.

A rule suggestion uses the configured reviewer or follows the current chat provider without a saved selection. The request sends only the checked command words and request ID. Configured private resources, detected credentials and explicit restrictions on sharing remain local.

### Finding a failed review

A local confirmation can explain why a command could not be sent for Auto approve. It identifies the condition and the affected field without quoting a secret. Choosing **Allow once** runs the pending command in its original sandbox. Declining, cancelling or having no interactive confirmation available leaves the command unexecuted.

A shell result beginning with `review_unavailable` means the command was held before launch. The result includes a diagnostic code and HTTP status when available. For example, the Codex OAuth route accepts a valid completed event stream even if the server omits `Content-Type`. If the header is missing and the body is empty or unrecognizable, the result includes `review_media_type_missing` and the HTTP status. A model decision to deny has its own result, `review_denied`.

During an active run the runtime writes classified technical failures as `approval.review_failure` records in the normal run JSONL. Search that run for the record type or request ID. The record contains the timestamp, run and request IDs, reason, diagnostic code and, when available, the evidence location, position or HTTP status. This works with debug logging off. Earlier runs contain only the detail recorded by the version that handled them.

### Provider routes and data handling

The eight assigned reviewers are experimental. The provider and privacy controls apply when a model is asked to suggest a reusable rule. The isolated local shell launch path uses the workspace setting.

- **OpenAI** · `gpt-6-luna`. An active ChatGPT sign-in uses the fixed Codex Responses route
  and the account's Codex usage limits. OpenAI API-key authentication uses the
  public Responses API and standard API billing. When the stored sign-in is
  bound to a known account, review can refresh it. If refresh fails, use the normal Codelia sign-in flow.
- **Google** · `gemini-4-hydrogen`. The public Gemini Interactions API runs with interaction storage
  disabled. Codelia cannot verify the API project's billing tier. Depending on
  region, unpaid terms may allow content use for product improvement and human
  review. Paid terms exclude product improvement and allow limited safety and
  legal logging. [Google terms](https://aistudio.google.com/docs/terms) ·
  [Interaction storage](https://aistudio.google.com/docs/interactions-overview#data-storage-retention)
- **Anthropic** · `claude-haiku-5-5`. Commercial API data is excluded from training by default and
  account retention terms apply. Anthropic may cache the static response schema
  for up to 24 hours. [Training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) ·
  [API retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
- **DeepSeek** · `deepseek-flash`. The provider's privacy policy describes personal data processing
  in China and possible use of inputs for model improvement. The
  `deepseek-flash` model identifier is a rolling alias.
  [Privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) ·
  [Model catalog](https://api-docs.deepseek.com/quick_start/pricing/)
- **xAI** · `grok-4.7`. The public Responses API runs with conversation storage disabled.
  Standard API audit retention is 30 days. Zero data retention is a team setting.
  [xAI API data policy](https://docs.x.ai/developers/faq/security)
- **Moonshot** · `kimi-k3.1-pro`. Kimi's terms allow customer content to be used for model
  improvement unless your agreement restricts that use. Its privacy policy
  gives account-active retention as an example for inputs.
  [Kimi API terms](https://platform.kimi.ai/docs/agreement/modeluse) ·
  [Privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy)
- **OpenRouter** · `openai/gpt-6-luna`. The review uses only the OpenRouter key and fixes the downstream
  endpoint to OpenAI Standard. Fallback is disabled and only matching routing
  metadata is accepted. Account-side BYOK can affect billing, and its
  review responses with unverifiable routing are discarded. Both providers' data terms apply.
  [OpenRouter data policies](https://openrouter.ai/docs/guides/privacy/data-collection)
- **Z.ai** · `glm-5.3`. The standard API terms restrict decision-making use. Auto approve
  requires an agreement that permits it.
  [Z.ai API terms](https://chat.z.ai/legal-agreement/terms-of-service)

SDK hosts can provide an `approvalReviewer` or use the standard public OpenAI
adapter with their configured API key. The runtime limits review to
registered categories and existing resource grants. Missing evidence and
unavailable review return the request to human confirmation.

A host can declare an external operation and its resource separately from the operation's ceiling and grant. The SDK's `runBrokeredMutation` helper issues one approved conditional update. If acknowledgement is lost, it uses a read-only observation to resolve the outcome.
