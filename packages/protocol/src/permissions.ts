import type { ApprovalMode } from "@codelia/shared-types";

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
	/** `system` = built-in allowlist for the approval mode (read-only). */
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

export type PermissionsListParams = {
	/** Include the built-in allowlist of the resolved approval mode. */
	include_system?: boolean;
};

export type PermissionsListResult = {
	/** Mode the next run resolves (null when it cannot be resolved). */
	approval_mode: {
		value: ApprovalMode;
		source: ApprovalModeSource;
		/** Mode of the currently built agent, when one exists. */
		active?: ApprovalMode;
	} | null;
	paths: { global: string; project: string | null };
	/** File order: global, then project (allow before deny), then system. */
	rules: PermissionRuleEntry[];
	errors?: Array<{
		scope: PermissionRuleScope | "approval_mode";
		message: string;
	}>;
};

export type PermissionsRemoveParams = {
	scope: PermissionRuleScope;
	kind: "allow" | "deny";
	/** Matched on all four fields; every equal entry in that file/list is removed. */
	rule: PermissionRuleSpec;
};

export type PermissionsRemoveResult = {
	scope: PermissionRuleScope;
	kind: "allow" | "deny";
	path: string;
	removed: number;
};
