import path from "node:path";
export type ApprovalOrigin =
	| "parent_agent"
	| "child_agent"
	| "operator"
	| "ui_bang"
	| "startup"
	| "mcp_service";
export type ExecutionProfile =
	| "investigation"
	| "development"
	| "full-access"
	| "host_managed";

export type Resource = Readonly<{
	operation: "read" | "write" | "network" | "invoke";
	target: string;
	scope?: "tree";
}>;

export type ApprovalFacts = Readonly<{
	valid: boolean;
	owned: boolean;
	registered: boolean;
	explicitDeny?: string;
	enforceable: boolean;
	profile: ExecutionProfile;
	requested: readonly Resource[];
	ceiling: readonly Resource[];
	granted: readonly Resource[];
	opaque?: boolean;
	opaqueReason?:
		| "indirect_execution"
		| "interactive_stdin"
		| "unrestricted_program"
		| "unbound_working_directory";
	requireAnalysis?: boolean;
	humanOnly?: "destructive" | "external_mutation" | "policy_change";
	launchRule?: string;
	reviewCategory?: "local_test" | "local_shell" | "dependency_read";
	/** A user selected Auto approve for this launch under an enforced local profile. */
	confinedAutoLaunch?: boolean;
	/** Confined TUI shell with user-enabled review and agent-facing fallbacks. */
	autoReview?: boolean;
}>;

export type ApprovalRoute = Readonly<{
	kind: "deny" | "human" | "immediate" | "review" | "defer";
	reason: string;
	profile: ExecutionProfile;
	resources: readonly Resource[];
	additional: readonly Resource[];
}>;

/** One parent shell launch outside the selected sandbox, as the login user. */
export const UNSANDBOXED_SHELL_RESOURCE: Resource = Object.freeze({
	operation: "invoke",
	target: "shell.unsandboxed",
});

export const isUnsandboxedShellResource = (item: Resource): boolean =>
	item.operation === UNSANDBOXED_SHELL_RESOURCE.operation &&
	item.target === UNSANDBOXED_SHELL_RESOURCE.target;

export const coversApprovalResource = (
	list: readonly Resource[],
	item: Resource,
): boolean =>
	list.some((entry) => {
		if (entry.operation !== item.operation) return false;
		if (entry.target === item.target) return true;
		if (
			entry.scope !== "tree" ||
			(item.operation !== "read" && item.operation !== "write") ||
			!path.isAbsolute(entry.target) ||
			!path.isAbsolute(item.target)
		)
			return false;
		const relative = path.relative(entry.target, item.target);
		return (
			!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`)
		);
	});

export const routeApproval = (facts: ApprovalFacts): ApprovalRoute => {
	const result = (
		kind: ApprovalRoute["kind"],
		reason: string,
		additional: readonly Resource[] = [],
	): ApprovalRoute => ({
		kind,
		reason,
		profile: facts.profile,
		resources: facts.requested,
		additional,
	});
	if (!facts.valid) return result("deny", "invalid_arguments");
	if (!facts.owned) return result("deny", "owner_mismatch");
	if (!facts.registered) return result("deny", "unregistered_tool");
	if (facts.explicitDeny) return result("deny", facts.explicitDeny);
	if (
		facts.requested.some((item) => !coversApprovalResource(facts.ceiling, item))
	)
		return result("deny", "outside_authority_ceiling");
	if (!facts.enforceable) return result("deny", "sandbox_unavailable");
	if (facts.opaque && facts.requireAnalysis)
		return result("deny", "analysis_required");

	const additional = facts.requested.filter(
		(item) => !coversApprovalResource(facts.granted, item),
	);
	if (additional.length) {
		const escalation = additional.some(isUnsandboxedShellResource);
		if (
			facts.autoReview &&
			(escalation
				? additional.length === 1
				: facts.granted.length > 0 &&
					additional.every((item) => item.operation === "write"))
		) {
			if (facts.reviewCategory)
				return result("review", facts.reviewCategory, additional);
			return result("defer", "review_evidence_unavailable", additional);
		}
		return result("human", "additional_resources", additional);
	}
	if (facts.confinedAutoLaunch)
		return result("immediate", "confined_auto_launch");
	if (facts.autoReview) {
		if (!facts.opaque && !facts.humanOnly && facts.launchRule)
			return result("immediate", facts.launchRule);
		if (facts.reviewCategory) return result("review", facts.reviewCategory);
		return result("defer", "review_evidence_unavailable");
	}
	if (facts.humanOnly) return result("human", facts.humanOnly);
	if (facts.opaque)
		return result("human", facts.opaqueReason ?? "opaque_invocation");
	if (facts.launchRule) return result("immediate", facts.launchRule);
	if (facts.reviewCategory) return result("review", facts.reviewCategory);
	return result("human", "no_launch_rule");
};
