import { realpathSync } from "node:fs";
import type {
	BaseMessage,
	ConversationApprovalProvenance,
	ConversationApprovalScope,
	ConversationInputOrigin,
} from "@codelia/core";
import type { ReviewUserText } from "./review-evidence";
import { directoryIdentity, isWithin } from "./shell-backend";

export function approvalHistoryScope(
	workspace: string | null,
	cwd: string | null,
): ConversationApprovalScope | undefined {
	if (!workspace) return undefined;
	try {
		const root = realpathSync(workspace);
		const workingDirectory = cwd ? realpathSync(cwd) : root;
		if (isWithin(root, workingDirectory))
			return {
				workspace: root,
				cwd: workingDirectory,
				workspaceIdentity: directoryIdentity(root),
				cwdIdentity: directoryIdentity(workingDirectory),
			};
	} catch {
		// Scope unavailable. Preserve the original transcript without approval provenance.
	}
}

export function approvalArchiveProvenance(
	message: BaseMessage,
	origin: ConversationInputOrigin | undefined,
	scope: ConversationApprovalScope | undefined,
	input: ReviewUserText | undefined,
	runId: string,
	steerText: (steerId: string) => ReviewUserText | undefined,
): ConversationApprovalProvenance | undefined {
	if (message.role === "assistant" && scope)
		return { source: "assistant", ...scope };
	if (message.role !== "user" || !origin) return undefined;
	if (origin.source === "internal_input") return { source: "internal_input" };
	const text =
		origin.source === "user_steer" ? steerText(origin.steerId) : input;
	if (scope && typeof text === "string" && text.length <= 1800)
		return origin.source === "user_steer"
			? {
					source: origin.source,
					...scope,
					text,
					runId,
					steerId: origin.steerId,
				}
			: { source: origin.source, ...scope, text };
}
