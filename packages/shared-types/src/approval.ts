import { z } from "zod";

export const ApprovalModeSchema = z
	.enum(["minimal", "trusted", "full-access"])
	.meta({ id: "ApprovalMode" });
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

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
export const SandboxModeSchema = z
	.enum(sandboxModes)
	.meta({ id: "SandboxMode" });
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const parseSandboxMode = (value: unknown): SandboxMode | undefined =>
	sandboxModes.find((mode) => mode === value);
