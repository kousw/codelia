export type ApprovalMode = "minimal" | "trusted" | "full-access";

export const parseApprovalMode = (value: unknown): ApprovalMode | undefined => {
	if (
		value === "minimal" ||
		value === "trusted" ||
		value === "full-access"
	) {
		return value;
	}
	return undefined;
};
