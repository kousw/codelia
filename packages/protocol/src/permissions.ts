import {
	ApprovalModeSchema,
	keyed,
	SandboxModeSchema,
	tagged,
	wireInt,
} from "@codelia/shared-types";
import { z } from "zod";

/** Same shape as `permissions.allow/deny` entries in config.json. */
const permissionRuleFields = {
	tool: z.string(),
	command: z.string().optional(),
	command_glob: z.string().optional(),
	skill_name: z.string().optional(),
};
export const PermissionRuleSpecSchema = z
	.object(permissionRuleFields)
	.meta({ id: "PermissionRuleSpec" });
export type PermissionRuleSpec = z.infer<typeof PermissionRuleSpecSchema>;

export const PermissionRuleScopeSchema = z
	.enum(["global", "project"])
	.meta({ id: "PermissionRuleScope" });
export type PermissionRuleScope = z.infer<typeof PermissionRuleScopeSchema>;

export const PermissionRuleKindSchema = z
	.enum(["allow", "deny"])
	.meta({ id: "PermissionRuleKind" });

export const PermissionRuleEntrySchema = z
	.object({
		kind: PermissionRuleKindSchema,
		/** `system` = built-in tool rules (read-only). */
		scope: z.enum(["global", "project", "system"]),
		rule: PermissionRuleSpecSchema,
		removable: z.boolean(),
	})
	.meta({ id: "PermissionRuleEntry" });
export type PermissionRuleEntry = z.infer<typeof PermissionRuleEntrySchema>;

export const ApprovalModeSourceSchema = z
	.enum(["cli", "env", "project", "default", "startup-selection", "fallback"])
	.meta({ id: "ApprovalModeSource" });
export type ApprovalModeSource = z.infer<typeof ApprovalModeSourceSchema>;

export const SandboxModeInfoSchema = z
	.object({
		value: SandboxModeSchema,
		source: z.enum(["sdk", "cli", "env", "project", "default", "fallback"]),
		legacy: ApprovalModeSchema.optional(),
	})
	.meta({ id: "SandboxModeInfo" });
export type SandboxModeInfo = z.infer<typeof SandboxModeInfoSchema>;

export const SandboxProjectChangeBlockSchema = z
	.enum([
		"runtime_busy",
		"cli_override",
		"env_override",
		"sdk_managed",
		"workspace_unavailable",
		"policy_acl_unverified",
		"policy_store_unavailable",
		"policy_store_busy",
	])
	.meta({ id: "SandboxProjectChangeBlock" });
export type SandboxProjectChangeBlock = z.infer<
	typeof SandboxProjectChangeBlockSchema
>;

export const SandboxModeChoiceBlockSchema = z
	.enum(["platform_unavailable"])
	.meta({ id: "SandboxModeChoiceBlock" });
export type SandboxModeChoiceBlock = z.infer<
	typeof SandboxModeChoiceBlockSchema
>;

export const SandboxModeChoiceSchema = z
	.object({
		id: SandboxModeSchema,
		label: z.string(),
		description: z.string(),
		unavailable_reason: SandboxModeChoiceBlockSchema.optional(),
	})
	.meta({ id: "SandboxModeChoice" });
export type SandboxModeChoice = z.infer<typeof SandboxModeChoiceSchema>;

/** The mode the current agent or run actually uses. */
export const SandboxAppliedSchema = z
	.object({
		value: SandboxModeSchema,
		target: z.enum(["agent", "run"]),
	})
	.meta({ id: "SandboxApplied" });

export const SandboxProjectWritableSchema = z
	.object({ writable: z.literal(true) })
	.meta({ id: "SandboxProjectWritable" });

export const SandboxProjectReadOnlySchema = z
	.object({
		writable: z.literal(false),
		reason: SandboxProjectChangeBlockSchema,
	})
	.meta({ id: "SandboxProjectReadOnly" });

export const SandboxGetResultSchema = z
	.object({
		effective: SandboxModeInfoSchema,
		applied: SandboxAppliedSchema.nullable(),
		project: tagged(
			"writable",
			[SandboxProjectWritableSchema, SandboxProjectReadOnlySchema],
			{ id: "SandboxProjectChange" },
		),
		choices: z.array(SandboxModeChoiceSchema),
	})
	.meta({ id: "SandboxGetResult" });
export type SandboxGetResult = z.infer<typeof SandboxGetResultSchema>;

export const SandboxGetParamsSchema = z
	.strictObject({})
	.meta({ id: "SandboxGetParams" });
export type SandboxGetParams = Record<string, never>;

export const SandboxSetParamsSchema = z
	.strictObject({ scope: z.literal("project"), mode: SandboxModeSchema })
	.meta({ id: "SandboxSetParams" });
export type SandboxSetParams = z.infer<typeof SandboxSetParamsSchema>;
export type SandboxSetResult = SandboxGetResult;
export const SandboxSetErrorDataSchema = z
	.object({
		reason: z.enum([
			...SandboxProjectChangeBlockSchema.options,
			...SandboxModeChoiceBlockSchema.options,
			"already_effective",
		]),
	})
	.meta({ id: "SandboxSetErrorData" });
export type SandboxSetErrorData = z.infer<typeof SandboxSetErrorDataSchema>;

export const PermissionsListParamsSchema = z
	.object({
		/** Include built-in tool rules. Conditions such as target and ownership still apply. */
		include_system: z.boolean().optional(),
	})
	.meta({ id: "PermissionsListParams" });
export type PermissionsListParams = z.infer<typeof PermissionsListParamsSchema>;

export const ProjectAllowTrustSchema = z
	.object({
		workspace: z.string(),
		trusted: z.boolean(),
		rules: z.array(PermissionRuleSpecSchema),
		revision: z.string(),
	})
	.meta({ id: "ProjectAllowTrust" });
export type ProjectAllowTrust = z.infer<typeof ProjectAllowTrustSchema>;

export const ProjectAllowTrustSetParamsSchema = z
	.object({
		workspace: z.string(),
		trusted: z.boolean(),
		expected_revision: z.string(),
	})
	.meta({ id: "ProjectAllowTrustSetParams" });
export type ProjectAllowTrustSetParams = z.infer<
	typeof ProjectAllowTrustSetParamsSchema
>;

export const ProjectAllowTrustSetResultSchema = z
	.object({ workspace: z.string(), trusted: z.boolean() })
	.meta({ id: "ProjectAllowTrustSetResult" });
export type ProjectAllowTrustSetResult = z.infer<
	typeof ProjectAllowTrustSetResultSchema
>;

export const PermissionRememberedToolSchema = z
	.object({ tool: z.string() })
	.meta({ id: "PermissionRememberedTool" });

/** Deprecated. Reports the selected legacy input, when one supplied the sandbox mode. */
export const ApprovalModeInfoSchema = z
	.object({
		value: ApprovalModeSchema,
		source: ApprovalModeSourceSchema,
		/** Deprecated. Retained as an optional field for older servers. */
		active: ApprovalModeSchema.optional(),
	})
	.meta({ id: "ApprovalModeInfo" });

export const PermissionPathsSchema = z
	.object({ global: z.string(), project: z.string().nullable() })
	.meta({ id: "PermissionPaths" });

export const PermissionLaunchRuleSchema = z
	.object({
		id: z.string(),
		template: z.string(),
		origin: z.enum(["parent_agent", "operator"]),
		executable: z.string(),
		profile: z.enum(["development", "investigation"]),
		cwd: z.string().optional(),
		args: z.array(z.string()).readonly().optional(),
		launchKind: z.enum(["source", "argv"]).optional(),
		argv0: z.string().optional(),
		source: z.string().optional(),
		scope: z.enum(["session", "project"]),
	})
	.meta({ id: "PermissionLaunchRule" });

export const PermissionsListErrorSchema = z
	.object({
		scope: z.enum([
			"global",
			"project",
			"approval_mode",
			"launch_rules",
			"project_allow_trust",
		]),
		message: z.string(),
	})
	.meta({ id: "PermissionsListError" });

export const PermissionsListResultSchema = z
	.object({
		/** Personal tool-only allowances scoped to this workspace. */
		remembered_tools: z.array(PermissionRememberedToolSchema).optional(),
		project_allow_trust: ProjectAllowTrustSchema.optional(),
		sandbox_mode: SandboxModeInfoSchema.optional(),
		approval_mode: ApprovalModeInfoSchema.nullable(),
		paths: PermissionPathsSchema,
		/** File order: global, then project (allow before deny), then system. */
		rules: z.array(PermissionRuleEntrySchema),
		workspace_write_granted: z.boolean().optional(),
		launch_rules: z.array(PermissionLaunchRuleSchema).optional(),
		errors: z.array(PermissionsListErrorSchema).optional(),
	})
	.meta({ id: "PermissionsListResult" });
export type PermissionsListResult = z.infer<typeof PermissionsListResultSchema>;

const LaunchRuleScopeSchema = z.enum(["session", "project"]);

const rememberedToolFields = {
	scope: z.literal("project"),
	remembered_tool: z.string(),
};
const workspaceWriteFields = {
	resource: z.literal("workspace_write"),
	scope: z.literal("session"),
};
const launchRuleFields = {
	launch_rule_id: z.string(),
	scope: LaunchRuleScopeSchema,
};

export const PermissionsRemoveRememberedToolSchema = z
	.strictObject(rememberedToolFields)
	.meta({ id: "PermissionsRemoveRememberedTool" });
export const PermissionsRemoveWorkspaceWriteSchema = z
	.strictObject(workspaceWriteFields)
	.meta({ id: "PermissionsRemoveWorkspaceWrite" });
export const PermissionsRemoveLaunchRuleSchema = z
	.strictObject(launchRuleFields)
	.meta({ id: "PermissionsRemoveLaunchRule" });
export const PermissionsRemoveRuleSchema = z
	.strictObject({
		scope: PermissionRuleScopeSchema,
		kind: PermissionRuleKindSchema,
		/** Matched on all four fields; every equal entry in that file/list is removed. */
		rule: z
			.strictObject(permissionRuleFields)
			.meta({ id: "PermissionRuleRemovalSpec" }),
	})
	.meta({ id: "PermissionsRemoveRule" });

export const PermissionsRemoveParamsSchema = keyed(
	[
		PermissionsRemoveRememberedToolSchema,
		PermissionsRemoveWorkspaceWriteSchema,
		PermissionsRemoveLaunchRuleSchema,
		PermissionsRemoveRuleSchema,
	],
	{ id: "PermissionsRemoveParams" },
);
export type PermissionsRemoveParams = z.infer<
	typeof PermissionsRemoveParamsSchema
>;

export const PermissionsRemovedRememberedToolSchema = z
	.object({ ...rememberedToolFields, removed: wireInt() })
	.meta({
		id: "PermissionsRemovedRememberedTool",
	});
export const PermissionsRemovedWorkspaceWriteSchema = z
	.object({ ...workspaceWriteFields, removed: wireInt() })
	.meta({
		id: "PermissionsRemovedWorkspaceWrite",
	});
export const PermissionsRemovedLaunchRuleSchema = z
	.object({ ...launchRuleFields, removed: wireInt() })
	.meta({
		id: "PermissionsRemovedLaunchRule",
	});
export const PermissionsRemovedRuleSchema = z
	.object({
		scope: PermissionRuleScopeSchema,
		kind: PermissionRuleKindSchema,
		path: z.string(),
		removed: wireInt(),
	})
	.meta({ id: "PermissionsRemovedRule" });

export const PermissionsRemoveResultSchema = keyed(
	[
		PermissionsRemovedRememberedToolSchema,
		PermissionsRemovedWorkspaceWriteSchema,
		PermissionsRemovedLaunchRuleSchema,
		PermissionsRemovedRuleSchema,
	],
	{ id: "PermissionsRemoveResult" },
);
export type PermissionsRemoveResult = z.infer<
	typeof PermissionsRemoveResultSchema
>;

export const AutoReviewStateSchema = z
	.enum(["off", "active", "unavailable"])
	.meta({ id: "AutoReviewState" });

export const AutoReviewConfinedLaunchIssueSchema = z
	.enum(["confined_launch_config_unavailable"])
	.meta({ id: "AutoReviewConfinedLaunchIssue" });

export const AutoReviewIssueSchema = z
	.enum([
		"unregistered_review_model",
		"review_reconfigure_required",
		"review_auth_unavailable",
		"review_auth_incompatible",
		"review_config_unavailable",
		"review_chat_provider_unresolved",
		"review_chat_provider_unsupported",
	])
	.meta({ id: "AutoReviewIssue" });

export const AutoReviewStatusSchema = z
	.object({
		mode: z.enum(["follow", "pin"]).optional(),
		/** Confined parent shell delegation, independent of reviewer state. */
		confined_launch_enabled: z.boolean().optional(),
		confined_launch_issue: AutoReviewConfinedLaunchIssueSchema.optional(),
		state: AutoReviewStateSchema,
		provider: z.string().optional(),
		model: z.string().optional(),
		label: z.string().optional(),
		details: z.array(z.string()).optional(),
		issue: AutoReviewIssueSchema.optional(),
	})
	.meta({ id: "AutoReviewStatus" });
export type AutoReviewStatus = z.infer<typeof AutoReviewStatusSchema>;

export const AutoReviewConfigureParamsSchema = z
	.strictObject({
		/** Default `pick`: interactive setup. */
		action: z.enum(["pick", "status", "off"]).optional(),
	})
	.meta({ id: "AutoReviewConfigureParams" });
export type AutoReviewConfigureParams = z.infer<
	typeof AutoReviewConfigureParamsSchema
>;
