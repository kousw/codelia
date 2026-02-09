# MCP Integration Spec（Codelia as MCP Host）

This document defines specifications for integrating the Model Context Protocol (MCP) into Codelia.
The target is a case where "Codelia uses an external MCP Server as a host",
It does not include the specifications provided by Codelia itself for MCP Server.

---

## 1. Goals / Non-Goals

Goals:
- Realize connection, capability negotiation, and tool invocation in accordance with MCP standard specifications (2025-11-25)
- Integrate existing runtime permission / sandbox / session designs without breaking them
- Prioritize remote HTTP (Streamable HTTP + OAuth) and enable production
- Allow stdio linkage to be handled using the same config model

Non-Goals:
- Implement all MCP functions (sampling / elicitation / tasks) at an early stage
- Bring MCP transport implementation to `@codelia/core`
- Major changes to Codelia's UI protocol at the initial stage

---

## 2. Standard Baseline

Compliant with:
- MCP Specification revision `2025-11-25`
- JSON-RPC 2.0 envelope

Requirements for initial implementation:
1. Compliance with the life cycle of `initialize` -> `notifications/initialized`
2. capability negotiation (server: `tools`, client: minimum required)
3. `tools/list` (for pagination) and `tools/call`
4. Best effort cancellation with `notifications/cancelled`
5. Implementation of request timeout (hung request prevention)
6. `/mcp` can display “currently loading/connecting MCP server status”

Requirements by operational profile:
- `production-http` (actual operation/priority):
- In addition to 1-6 above, Remote HTTP/OAuth (Section 10) is required
- Require header handling of `MCP-Protocol-Version`/`MCP-Session-Id`
- Require auth/token persistence when connecting to protected server
- `local-stdio` (local use):
- Can be used if 1-6 above are met
- `resources/*`, `prompts/*`, `completion/complete` are optional

Future consideration:
- `tasks` utilities

---

## 3. Role Mapping（MCP <-> Codelia）

- MCP Host: Codelia runtime（`@codelia/runtime`）
- MCP Client: client per server connection in runtime
- MCP Server: External process/external HTTP endpoint
- LLM/Agent Loop: `@codelia/core` (doesn't know MCP transport)

Design principles:
- `core` remains MCP independent
- runtime adapts capabilities derived from MCP server to Tool and passes them to core

---

## 4. Package Boundaries

### 4.1 `@codelia/runtime`

Responsibilities:
- MCP server connection management (startup/initialization/reconnection/termination)
- Discovery of MCP tools and generation of Tool adapter
- MCP request timeout / cancel / logging
- Integration with permission (human approval flow)

### 4.2 `@codelia/core`

Responsibilities:
- Run the MCP adapter tool in the same way as a normal tool according to the tool contract.

Prohibited:
- Does not have MCP transport or lifecycle implementation

### 4.3 `@codelia/protocol`

Initial stage:
- Core <-> UI protocol is not changed (used via run.start/run.cancel)

future:
- Add method when MCP server status display or reload operation is required

---

## 5. Config Schema（Proposed）

Add `mcp` section to `config.json`.

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "remote-tools": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "enabled": true,
        "headers": {
          "X-Workspace": "codelia"
        },
        "request_timeout_ms": 30000
      },
      "filesystem-local": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/kousw/cospace/codelia"
        ],
        "cwd": "/home/kousw/cospace/codelia",
        "env": {
          "NODE_ENV": "production"
        },
        "request_timeout_ms": 30000
      }
    }
  }
}
```

Type (draft):

```ts
type McpServerConfig = {
  transport: "stdio" | "http";
  enabled?: boolean;              // default true
  command?: string;               // stdio required
  args?: string[];                // stdio optional
  cwd?: string;                   // stdio optional
  env?: Record<string, string>;   // stdio/http optional
  url?: string;                   // http required
  headers?: Record<string, string>; // http optional static headers
  request_timeout_ms?: number;    // default 30000
  oauth?: {                       // http optional
    authorization_url?: string;
    token_url?: string;
    registration_url?: string;
    client_id?: string;
    client_secret?: string;
    scope?: string;
  };
};

type McpConfig = {
  servers: Record<string, McpServerConfig>;
};
```

server id (key of `servers`) validation:

- 1..64 characters
- Regular expression: `^[a-zA-Z0-9_-]{1,64}$`
- Duplicate definition of the same ID is not allowed in the same config file
- If multiple layers (global/project) have the same ID, priority will be given to the project side as per existing specifications

Similar to the skill name validation, this restriction aims to "prevent ambiguous references" and "stabilize identifiers during operation."

remarks:
- Priority target for actual operation is `transport: "http"`
- `transport: "stdio"` will continue to be supported in local profile

### 5.1 Minimal Examples

remote only:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "remote-tools": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "enabled": true
      }
    }
  }
}
```

stdio only:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "filesystem-local": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/kousw/cospace/codelia"
        ],
        "enabled": true
      }
    }
  }
}
```

### 5.1.1 Practical Examples (for copy/paste)

remote HTTP (real/public endpoint/no authentication required):

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "mcp-registry-public": {
        "transport": "http",
        "url": "https://registry.run.mcp.com.ai/mcp",
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

remote HTTP (actual/public endpoint/no authentication required, other example):

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "petstore-public": {
        "transport": "http",
        "url": "https://petstore.run.mcp.com.ai/mcp",
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

remote HTTP (real endpoint / OAuth required example):

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "notion": {
        "transport": "http",
        "url": "https://mcp.notion.com/mcp",
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

remote HTTP (existence endpoint / OAuth required, example of explicitly specifying endpoint):

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "gossiper-oauth": {
        "transport": "http",
        "url": "https://mcp.gossiper.io/mcp",
        "enabled": true,
        "request_timeout_ms": 30000,
        "oauth": {
          "authorization_url": "https://mcp.gossiper.io/oauth2/authorize",
          "token_url": "https://mcp.gossiper.io/oauth2/token",
          "registration_url": "https://mcp.gossiper.io/oauth2/register",
          "scope": "mcp"
        }
      }
    }
  }
}
```

local stdio（filesystem server）:

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "filesystem-local": {
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "/home/kousw/cospace/codelia"
        ],
        "cwd": "/home/kousw/cospace/codelia",
        "env": {
          "NODE_ENV": "production"
        },
        "enabled": true,
        "request_timeout_ms": 30000
      }
    }
  }
}
```

Example of disabling global definition on project side (`<cwd>/.codelia/config.json`):

```json
{
  "version": 1,
  "mcp": {
    "servers": {
      "mcp-registry-public": {
        "transport": "http",
        "url": "https://registry.run.mcp.com.ai/mcp",
        "enabled": false
      }
    }
  }
}
```

supplement:
- If the token is missing/expired in `mcp-auth.json` on an HTTP server that requires OAuth, the runtime will start the OAuth Authorization Code + PKCE flow upon connection and display a browser startup confirmation on the UI (manual token input is not required).
- OAuth metadata (`authorization_url`/`token_url`/`registration_url`) can be explicitly specified in `mcp.servers.<id>.oauth.*` of `config.json`. If not specified, automatic detection will be attempted from `/.well-known/oauth-protected-resource` and authorization-server metadata.
- A server that cannot detect OAuth metadata will not issue an OAuth prompt and will simply display it as a connection error (e.g. API key header required for server, set `headers.Authorization`).
- The `${...}` format within `config.json` is not automatically expanded at runtime. When using `client_secret`, it is necessary to write the actual value.
- Avoid embedding `client_secret` in plain text, and use prompt input operations or secret distribution methods if possible.
- The above `registry.run.mcp.com.ai` / `petstore.run.mcp.com.ai` have confirmed the `initialize` response as of 2026-02-07.
- The above `search-mcp.parallel.ai/mcp` has confirmed `initialize` 401 and OAuth metadata (protected-resource + authorization-server) responses as of 2026-02-07.
- The above `mcp.gossiper.io/mcp` has confirmed `initialize` 401 and OAuth metadata (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`) responses as of 2026-02-07.

### 5.2 CLI Config Operations（Proposed）

Allows the `codelia mcp` subcommand to edit `mcp.servers` of `config.json`.
The main purpose is to quickly add and manage remote servers.

command:

```bash
codelia mcp add <server-id> --transport http --url <mcp-endpoint> [options]
codelia mcp add <server-id> --transport stdio --command <cmd> [options]
codelia mcp list [--scope effective|project|global]
codelia mcp remove <server-id> [--scope project|global]
codelia mcp enable <server-id> [--scope project|global]
codelia mcp disable <server-id> [--scope project|global]
codelia mcp test <server-id> [--scope effective|project|global]
```

Main options:
- common:
  - `--scope <project|global>`（`add/remove/enable/disable`）
  - `--enabled <true|false>`（`add`）
  - `--request-timeout-ms <ms>`（`add`）
- `--replace` (overwrite existing id)
- http:
- `--url <https://.../mcp>` (required)
- `--header <key=value>` (multiple specifications possible)
  - `--oauth-authorization-url <https://.../authorize>`
  - `--oauth-token-url <https://.../token>`
  - `--oauth-registration-url <https://.../register>`
  - `--oauth-client-id <id>`
  - `--oauth-client-secret <secret>`
  - `--oauth-scope <scope>`
- stdio:
- `--command <cmd>` (required)
- `--arg <value>` (multiple specifications possible)
  - `--cwd <path>`
- `--env <key=value>` (multiple specifications possible)

Scope default:
- `add/remove/enable/disable`: `project`
- `list/test`: `effective`

Error/Conflict:
- If `add` has the same `server-id` in the same scope:
- Without `--replace`: failure
- With `--replace`: Overwrite
- `remove` only deletes the definition of the target scope
- Even if you delete it in the project, if there is a global definition, it will remain effective.

output:
- `list --scope effective` displays `source` (`project`/`global`)
- `test` executes connection, `initialize`, and `tools/list` and returns success or failure.

### 5.3 Config Loading / Merge Rules

MCP settings are handled in the same layer as reading the existing runtime config.

Load order (low -> high):
1. Global config (`CODELIA_CONFIG_PATH` or storage default)
2. Project config（`<cwd>/.codelia/config.json`）

Merge rules:
- `mcp.servers` merges by server id (map key)
- If the same server id exists on both sides, give priority to the project side
- Use `enabled: false` to disable server in project
- server with `enabled !== true` does not connect when runtime starts

Validity check:
- `transport: "http"` requires `url`
- `transport: "stdio"` requires `command`
- Invalid entries will disable only that server, but the entire runtime will continue.

### 5.4 Runtime Visibility Command (`/mcp` required)

`/mcp` displays "MCP state currently recognized by runtime" instead of "configured".
The purpose is different from `codelia mcp list` (static setting).

Required behavior:
1. `/mcp`:
- List status of all servers
- Contains at least the following columns:
     - `id`
     - `transport`
     - `source`（`project` / `global`）
     - `enabled`
     - `state`（`disabled` / `connecting` / `auth_required` / `ready` / `error`）
- `tools` (number of tools currently available)
2. `/mcp <server-id>`:
- Display details of specified server
- Show `last_error` (if available) and `last_connected_at`
3. When server is not set:
- Explicitly display "no MCP servers configured"

Implementation notes:
- UI is displayed by calling runtime's `mcp.list` RPC
- `/mcp` is readable even during run (for checking status)

---

## 6. Connection Lifecycle

For each server runtime:

1. Establish connection (stdio subprocess startup or HTTP endpoint preparation)
2. `initialize` Send request
   - `protocolVersion`: `2025-11-25`
   - `clientInfo`: `{ name, version }`
- `capabilities`: Minimum (`roots` not provided initially)
3. `initialize` response validation
- Disconnect if `protocolVersion` mismatch and unsupported
- If `capabilities.tools` is missing, disable tool linkage for that server
4. `notifications/initialized` Send
5. Get tool catalog with `tools/list` (all items using cursor)

Reconnect:
- Connection loss is handled on a per-server basis, and other servers and local tools continue.
- If disconnected during run, the corresponding tool call will be returned as an error.

---

## 7. Tool Adapter Contract

### 7.1 Tool Name Mapping

The MCP tool name is normalized by runtime to satisfy the provider constraint.

- Public name: `mcp_<serverId>_<toolSlug>_<hash8>`
- Resolves to `(serverId, originalToolName)` with reverse table
- Be sure to include origin (`MCP server/tool`) in the description

This results in:
- Avoid collision with local tool
- Absorb name constraint difference on OpenAI/Anthropic side

### 7.2 Schema Handling

- MCP `inputSchema` is used for tool `parameters`
- If `inputSchema` is invalid/undefined
Fallback to `{ "type": "object", "additionalProperties": true }`
- Treat schema as untrusted input and set a size limit (DoS prevention)

### 7.3 Call Flow

1. Agent calls adapter tool
2. runtime determines permission
3. Send MCP `tools/call`
4. Convert the response to ToolResult and return it to core

For `isError: true`:
- adapter returns Tool execution error and sets it to `ToolMessage.is_error = true`
- content includes the error content returned by server

### 7.4 Cancellation / Timeout

- Apply timeout to each request
- Send `notifications/cancelled` to in-flight MCP request when canceling run
- Allow response to be ignored even if it arrives later due to conflict

---

## 8. Permissions / Safety

Because MCP tools cross trust boundaries, they are treated more strictly than local tools.

1. Default judgment is `confirm`
2. When enabled, `server/tool` and arguments are clearly displayed on the UI.
3. MCP metadata (description/annotations) is treated as untrusted
4. Limit the size of the return payload and omit the excess size + reference
5. Mask secret with logging

---

## 9. Resources / Prompts（Phase 2）

Scope covered by Phase 2:
- `resources/list`, `resources/templates/list`, `resources/read`
- `prompts/list`, `prompts/get`

How to publish:
- Published as local standard tool (e.g. `mcp_resources_list`, `mcp_resource_read`)
- prompt prioritizes user-driven operations over LLM automatic execution

Notification support:
- `notifications/resources/list_changed`
- `notifications/prompts/list_changed`

---

## 10. Remote HTTP / OAuth (Phase 1, production required)

Supported in Phase 1 (remote priority):
- Streamable HTTP transport（`POST`/`GET`/SSE）
- `MCP-Protocol-Version` / `MCP-Session-Id` header handling
- protected resource metadata discovery using RFC9728
- OAuth 2.1 flow (MCP authorization spec compliant)

`mcp-auth.json`（planned format）:

```json
{
  "version": 1,
  "servers": {
    "example-http-server": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": 1760000000000,
      "token_type": "Bearer",
      "scope": "files:read",
      "client_id": "...",
      "client_secret": "..."
    }
  }
}
```

Note:
- stdio transport is not subject to OAuth as per MCP standard (managed by environment variables/local settings)

---

## 11. Rollout Plan / Acceptance

### Phase 1（Remote MVP: HTTP/OAuth + tools）

Acceptance:
1. `initialize`/`initialized` to HTTP MCP server succeeds
2. Communication including `MCP-Protocol-Version`/`MCP-Session-Id` is established.
3. Can connect to protected server via OAuth
4. `tools/list`/`tools/call` can be executed during run and error/cancel is propagated
5. Permission confirm works, but tool error occurs when denying

### Phase 2（Local parity: stdio + tools）

Acceptance:
1. stdio MCP server can be handled with the same `mcp.servers` of `config.json`
2. `notifications/cancelled` is sent on run cancel

### Phase 3（resources/prompts）

Acceptance:
1. Resources/prompts retrieval tool is available
2. Catalog is updated by the next run with list_changed notification

### Release Gates

- Remote Beta conditions:
- Phase 1 completed (HTTP/OAuth + tools)
- Local Beta conditions:
- Phase 2 completed (stdio parity)
- Production GA conditions:
- Phase 1 completed (including HTTP/OAuth)
- `production-http` Meets profile requirements

---

## 12. References

- MCP Spec 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25
- Lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Resources: https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- Prompts: https://modelcontextprotocol.io/specification/2025-11-25/server/prompts
- Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
