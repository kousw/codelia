import { z } from "zod";
import { ServerCapabilitiesSchema, UiCapabilitiesSchema } from "./capabilities";
import {
	AutoReviewConfinedLaunchIssueSchema,
	AutoReviewIssueSchema,
	AutoReviewStateSchema,
	SandboxModeInfoSchema,
} from "./permissions";
import { ProtocolVersionSchema } from "./version";

const PeerInfoSchema = z
	.object({ name: z.string(), version: z.string() })
	.meta({ id: "PeerInfo" });

// The runtime has always accepted `{}` here (embedded hosts and older clients
// send partial params), so both fields stay optional on the wire.
export const InitializeParamsSchema = z
	.object({
		protocol_version: ProtocolVersionSchema.optional(),
		client: PeerInfoSchema.optional(),
		ui_capabilities: UiCapabilitiesSchema.optional(),
	})
	.meta({ id: "InitializeParams" });
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

export const InitializeLocalHostSchema = z
	.object({
		auto_review: AutoReviewStateSchema.optional(),
		auto_review_confined_launch_enabled: z.boolean().optional(),
		auto_review_confined_launch_issue:
			AutoReviewConfinedLaunchIssueSchema.optional(),
		auto_review_issue: AutoReviewIssueSchema.optional(),
	})
	.meta({ id: "InitializeLocalHost" });
export type InitializeLocalHost = z.infer<typeof InitializeLocalHostSchema>;

export const InitializeResultSchema = z
	.object({
		model_providers: z.array(z.string()).optional(),
		protocol_version: ProtocolVersionSchema,
		server: PeerInfoSchema,
		server_capabilities: ServerCapabilitiesSchema.optional(),
		sandbox_mode: SandboxModeInfoSchema.optional(),
		shell_sandbox_issue: z.enum(["windows_native_unqualified"]).optional(),
		local_host: InitializeLocalHostSchema.optional(),
		tui: InitializeLocalHostSchema.extend({
			theme: z.string().optional(),
		}).optional(),
	})
	.meta({ id: "InitializeResult" });
export type InitializeResult = z.infer<typeof InitializeResultSchema>;
