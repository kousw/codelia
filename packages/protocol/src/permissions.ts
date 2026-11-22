import {
	type ApprovalMode,
	ApprovalModeSchema,
	type SandboxMode,
	SandboxModeSchema,
} from "@codelia/shared-types";
import { z } from "zod";

/** Same shape as `permissions.allow/deny` entries in config.json. */
export type PermissionRuleSpec = {
	tool: string;
	command?: string;
	command_glob?: string;
	skill_name?: string;
};

export type PermissionRuleScope = "global" | "project";

export type PermissionRuleEntry = {
	kind: "allow" | "deny";
	/** `system` = built-in tool rules (read-only). */
	scope: PermissionRuleScope | "system";
	rule: PermissionRuleSpec;
	removable: boolean;
};

export type ApprovalModeSource =
	| "cli"
	| "env"
	| "project"
	| "default"
	| "startup-selection"
	| "fallback";

export const SandboxModeInfoSchema = z
	.object({
		value: SandboxModeSchema,
		source: z.enum(["sdk", "cli", "env", "project", "default", "fallback"]),
		legacy: ApprovalModeSchema.optional(),
	})
	.meta({ id: "SandboxModeInfo" });
export type SandboxModeInfo = z.infer<typeof SandboxModeInfoSchema>;

export type SandboxProjectChangeBlock =
	| "runtime_busy"
	| "cli_override"
	| "env_override"
	| "sdk_managed"
	| "workspace_unavailable"
	| "policy_acl_unverified"
	| "policy_store_unavailable"
	| "policy_store_busy";

export type SandboxModeChoiceBlock = "platform_unavailable";

export type SandboxModeChoice = {
	id: SandboxMode;
	label: string;
	description: string;
	unavailable_reason?: SandboxModeChoiceBlock;
};

export type SandboxGetResult = {
	effective: SandboxModeInfo;
	applied: { value: SandboxMode; target: "agent" | "run" } | null;
	project:
		| { writable: true }
		| { writable: false; reason: SandboxProjectChangeBlock };
	choices: SandboxModeChoice[];
};

export type SandboxGetParams = Record<string, never>;
export type SandboxSetParams = { scope: "project"; mode: SandboxMode };
export type SandboxSetResult = SandboxGetResult;
export type SandboxSetErrorData = {
	reason:
		| SandboxProjectChangeBlock
		| SandboxModeChoiceBlock
		| "already_effective";
};

export type PermissionsListParams = {
	/** Include built-in tool rules. Conditions such as target and ownership still apply. */
	include_system?: boolean;
};

export type ProjectAllowTrust = {
	workspace: string;
	trusted: boolean;
	rules: PermissionRuleSpec[];
	revision: string;
};

export type ProjectAllowTrustSetParams = {
	workspace: string;
	trusted: boolean;
	expected_revision: string;
};

export type ProjectAllowTrustSetResult = Pick<
	ProjectAllowTrust,
	"workspace" | "trusted"
>;

export type PermissionsListResult = {
	/** Personal tool-only allowances scoped to this workspace. */
	remembered_tools?: Array<{ tool: string }>;
	project_allow_trust?: ProjectAllowTrust;
	sandbox_mode?: SandboxModeInfo;
	/** Deprecated. Reports the selected legacy input, when one supplied the sandbox mode. */
	approval_mode: {
		value: ApprovalMode;
		source: ApprovalModeSource;
		/** Deprecated. Retained as an optional field for older servers. */
		active?: ApprovalMode;
	} | null;
	paths: { global: string; project: string | null };
	/** File order: global, then project (allow before deny), then system. */
	rules: PermissionRuleEntry[];
	workspace_write_granted?: boolean;
	launch_rules?: Array<{
		id: string;
		template: string;
		origin: "parent_agent" | "operator";
		executable: string;
		profile: "development" | "investigation";
		cwd?: string;
		args?: readonly string[];
		launchKind?: "source" | "argv";
		argv0?: string;
		source?: string;
		scope: "session" | "project";
	}>;
	errors?: Array<{
		scope:
			| PermissionRuleScope
			| "approval_mode"
			| "launch_rules"
			| "project_allow_trust";
		message: string;
	}>;
};

export type PermissionsRemoveParams =
	| { scope: "project"; remembered_tool: string }
	| { resource: "workspace_write"; scope: "session" }
	| {
			launch_rule_id: string;
			scope: "session" | "project";
	  }
	| {
			scope: PermissionRuleScope;
			kind: "allow" | "deny";
			/** Matched on all four fields; every equal entry in that file/list is removed. */
			rule: PermissionRuleSpec;
	  };

export type PermissionsRemoveResult =
	| { scope: "project"; remembered_tool: string; removed: number }
	| { resource: "workspace_write"; scope: "session"; removed: number }
	| {
			launch_rule_id: string;
			scope: "session" | "project";
			removed: number;
	  }
	| {
			scope: PermissionRuleScope;
			kind: "allow" | "deny";
			path: string;
			removed: number;
	  };

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

export type AutoReviewStatus = {
	mode?: "follow" | "pin";
	/** Confined parent shell delegation, independent of reviewer state. */
	confined_launch_enabled?: boolean;
	confined_launch_issue?: z.infer<typeof AutoReviewConfinedLaunchIssueSchema>;
	state: z.infer<typeof AutoReviewStateSchema>;
	provider?: string;
	model?: string;
	label?: string;
	details?: string[];
	issue?: z.infer<typeof AutoReviewIssueSchema>;
};
