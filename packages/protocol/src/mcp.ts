import { wireInt } from "@codelia/shared-types";
import { z } from "zod";

export const McpListScopeSchema = z
	.enum(["loaded", "configured"])
	.meta({ id: "McpListScope" });
export type McpListScope = z.infer<typeof McpListScopeSchema>;

export const McpServerTransportSchema = z
	.enum(["http", "stdio"])
	.meta({ id: "McpServerTransport" });
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

export const McpServerStateSchema = z
	.enum(["disabled", "connecting", "auth_required", "ready", "error"])
	.meta({ id: "McpServerState" });
export type McpServerState = z.infer<typeof McpServerStateSchema>;

export const McpListParamsSchema = z
	.object({ scope: McpListScopeSchema.optional() })
	.meta({ id: "McpListParams" });
export type McpListParams = z.infer<typeof McpListParamsSchema>;

export const McpListServerSchema = z
	.object({
		id: z.string(),
		transport: McpServerTransportSchema,
		source: z.enum(["project", "global"]).optional(),
		enabled: z.boolean(),
		state: McpServerStateSchema,
		/** Number of tools the server exposes once connected. */
		tools: wireInt().optional(),
		last_error: z.string().optional(),
		last_connected_at: z.string().optional(),
	})
	.meta({ id: "McpListServer" });
export type McpListServer = z.infer<typeof McpListServerSchema>;

export const McpListResultSchema = z
	.object({ servers: z.array(McpListServerSchema) })
	.meta({ id: "McpListResult" });
export type McpListResult = z.infer<typeof McpListResultSchema>;
