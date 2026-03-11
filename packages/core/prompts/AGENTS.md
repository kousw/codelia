# prompts

## Scope

- `system.md` is the shared default system prompt for Codelia.
- Keep this prompt focused on cross-task, cross-repo operating rules.

## Structure

- Organize the prompt by stable mental model: mission, priorities, workflow, tool use, safety, verification, task modes, and communication.
- Put benchmark-specific or harness-specific behavior in adapters, not here.
- Keep tool parameter details, limits, and edge cases in tool descriptions or runtime docs when possible.
- Avoid duplicating the same rule across multiple sections unless repetition is necessary for safety.
- Keep the shared prompt collaborative and action-oriented: prefer early concrete exploration, and let stronger verification guidance dominate later in the task.
