# Architecture & Implementation Comparisons

This directory collects durable comparative research across coding agents (such as Claude Code, Codex, and sibling CLI/TUI agents) that informs Codelia's runtime boundaries, sandboxing, or orchestration design. Keep one-off exploration notes in ignored `plan/` files rather than here.

- **Sandbox HOME, Git metadata writes, and PTY allocation** (Codex & Claude Code `sandbox-runtime`): [`sandbox-git-home.md`](./sandbox-git-home.md)
- **Subagent implementation comparison** (Codex, Claude Code, Gemini CLI, Qwen Code, OpenCode, xAI Grok Build): [`subagent-implementations.md`](./subagent-implementations.md)
