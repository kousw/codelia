export type ApprovalMode = "minimal" | "trusted" | "full-access";

export const parseApprovalMode = (value: unknown): ApprovalMode | undefined => {
	if (value === "minimal" || value === "trusted" || value === "full-access") {
		return value;
	}
	return undefined;
};

export const sandboxModes = [
	"readonly",
	"workspace-write",
	"full-access",
] as const;
export type SandboxMode = (typeof sandboxModes)[number];

export const parseSandboxMode = (value: unknown): SandboxMode | undefined =>
	sandboxModes.find((mode) => mode === value);
