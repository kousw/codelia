# basic-cli example

This example keeps the legacy `core` direct-usage CLI outside product paths.

Run:

```bash
bun examples/basic-cli/src/basic-cli.ts -p "List all TypeScript files"
```

Override model for a single run (without editing config):

```bash
bun examples/basic-cli/src/basic-cli.ts -m openai/gpt-5.2 -p "List all TypeScript files"
```
