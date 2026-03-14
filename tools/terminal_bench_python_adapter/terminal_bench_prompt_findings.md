# Terminal Bench Prompt Findings

This note is intentionally separate from `system_terminal_bench.md`.
The prompt file is the pruned baseline derived from the shared `system.md`.
This file captures what the latest completed jobs suggest should be added or adjusted on top of that baseline.
Terminal Bench runs are non-interactive, so these additions should prefer local assumptions and concrete next actions over asking the user for clarification.

## What the direct logs showed

- `filter-js-from-html` and `video-processing` repeatedly relied on handcrafted probes or the provided example input, then finished with strong local confidence and still scored `0`.
- `qemu-alpine-ssh` and `install-windows-3.11` spent substantial effort proving infrastructure was live inside the agent session, then ended on a "should now work" style conclusion that did not hold for the verifier.
- `gpt2-codegolf`, `caffe-cifar-10`, and `train-fasttext` repeatedly consumed large chunks of the budget on speculative reverse engineering, long builds, or repeated high-cost runs before establishing a cheap path to success.
- `mteb-retrieve` and `gpt2-codegolf` both lost turns to invalid long foreground `shell` timeouts before retrying with valid settings.
- `query-optimize` and `db-wal-recovery` show that some failures still happen even after solid local evidence, so the prompt should target broad behavioral mistakes rather than overfit to one task.

## Additions that look worthwhile

- Explicitly say that final verification runs outside the current session.
- Explicitly tell the agent not to stop at self-made sample probes when task files, scripts, output paths, or verifier-facing artifacts can tighten the contract.
- Explicitly tell the agent not to end with "it should now work" or "you should now be able to" for services, VMs, ports, or UI tasks.
- Explicitly tell the agent to verify service- or VM-based tasks from a fresh command that mimics the external observer.
- Explicitly tell the agent to do a cheap feasibility check before expensive training, compilation, reverse engineering, or infrastructure setup.
- Explicitly tell the agent to pivot after repeated probes fail to improve external evidence.
- Explicitly remind the agent to respect shell timeout limits and to use retained shell task tools for long finite work.

## Adjustments that may be worthwhile

- Change "Prefer inspecting the workspace over guessing" to mention task files, scripts, and output paths more concretely.
- Strengthen "Optimize for the real task contract" with examples of weak proxies: example-only inputs, custom sample probes, infrastructure liveness, and in-session state.
- Tighten completion language for external-facing tasks so local setup evidence is not mistaken for task completion.
- Tighten the shell section so long-running work is more clearly split into:
  - cheap viability probe first
  - retained task when expensive work is still justified
  - explicit final result check before relying on it

## Prompts changes that should stay separate from the baseline

- Anti-cheating rules about leaked trajectories, `solution.sh`, `task.yaml`, benchmark metadata, or external task copies.
- Benchmark-specific language such as "passing verifier" and "final verification runs outside your session".
- Concrete guidance about sample-only overfitting, session-dependent success, and expensive-run pivoting.

These are benchmark-specific additions and should be layered on top of the baseline rather than folded into the baseline itself.
