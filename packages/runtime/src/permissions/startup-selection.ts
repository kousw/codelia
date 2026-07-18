import type { UiPickRequestParams, UiPickResult } from "@codelia/protocol";
import { type ApprovalMode, parseApprovalMode } from "@codelia/shared-types";

const APPROVAL_MODE_STARTUP_PICK_TITLE =
	"Choose approval mode for this project";
const APPROVAL_MODE_STARTUP_PICK_ITEMS: Array<{
	id: ApprovalMode;
	label: string;
	detail: string;
}> = [
	{
		id: "minimal",
		label: "minimal",
		detail: "Recommended default. Non-allowed operations require confirmation.",
	},
	{
		id: "trusted",
		label: "trusted",
		detail:
			"Adds workspace write-oriented allowlist. Other operations still require confirmation.",
	},
	{
		id: "full-access",
		label: "full-access",
		detail: "Skips confirmation for non-denied operations.",
	},
];

export type ApprovalModeStartupSelectionGateway = {
	pick: (params: UiPickRequestParams) => Promise<UiPickResult | null>;
	log: (message: string) => void;
};

export const requestApprovalModeStartupSelection = async (
	gateway: ApprovalModeStartupSelectionGateway,
	projectKey: string,
): Promise<ApprovalMode | null> => {
	const selection = await gateway.pick({
		title: APPROVAL_MODE_STARTUP_PICK_TITLE,
		items: APPROVAL_MODE_STARTUP_PICK_ITEMS,
		multi: false,
	});
	const picked = parseApprovalMode(selection?.ids?.[0]);
	if (!picked) {
		gateway.log(
			`approval_mode startup selection skipped project=${projectKey}`,
		);
		return null;
	}
	return picked;
};
