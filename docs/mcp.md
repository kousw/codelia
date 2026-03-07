# MCP

MCP lets Codelia connect to external tool servers.
Use it when you want the TUI coding agent to access tools that are not built into the local runtime.

## What MCP is good for

Common use cases:
- connecting project-specific tool servers
- talking to remote HTTP MCP endpoints
- exposing local stdio-based tools through MCP
- giving the agent access to external systems in a structured way

## Two transport styles

The config/CLI transport names are:
- `http`
- `stdio`

More precisely:
- `http` is the current Streamable HTTP transport
- `stdio` is the local process transport

In practice:
- use `http` for remote/shared servers
- use `stdio` for local tool processes

## Basic workflow

A good first workflow is:

```sh
codelia mcp add my-server --transport stdio --command uvx --arg my-mcp
codelia mcp list
codelia mcp test my-server
```

Then launch the TUI and inspect loaded MCP servers with:

```text
/mcp
```

## Project vs global scope

Most MCP commands accept scopes.

- `project` keeps the server config in the current repo
- `global` makes it available more broadly
- `effective` is the merged view used by listing/testing

A practical rule:
- use `project` for repo-specific servers
- use `global` for personal shared servers

## Common commands

List servers:

```sh
codelia mcp list
codelia mcp list --scope effective
```

Add a stdio server:

```sh
codelia mcp add local-demo --transport stdio --command uvx --arg my-mcp
```

Add an HTTP server:

```sh
codelia mcp add remote-demo --transport http --url https://example.com/mcp --scope global
```

Test a server:

```sh
codelia mcp test local-demo
```

Disable or remove a server:

```sh
codelia mcp disable local-demo
codelia mcp remove local-demo
```

## Auth tokens

If an MCP server needs auth, manage its tokens with:

```sh
codelia mcp auth list
codelia mcp auth set my-server --access-token <token>
codelia mcp auth clear my-server
```

For HTTP servers, `codelia mcp test` automatically uses a stored bearer token when one exists for that server id.

## TUI usage

Inside the TUI, `/mcp` is the fastest way to inspect currently loaded MCP server state.
Once a server is configured and available, the agent can use the tools exposed by that server during a run.

## Related docs

- CLI reference: [`reference/cli.md`](./reference/cli.md)
- Skills: [`skills.md`](./skills.md)
- AGENTS.md: [`agents-md.md`](./agents-md.md)
