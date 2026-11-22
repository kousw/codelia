import { RPC_ERROR_CODE, type RpcErrorCode } from "@codelia/protocol";
import { isCanonicalHomeWorkspaceSync } from "@codelia/storage";
import { z } from "zod";
import {
	reviewChatRouteForStatus,
	runtimeLocalAutoReview,
} from "../permissions/local-reviewer";
import {
	localReviewModels,
	type RegisteredReviewModel,
	reviewModelLabel,
} from "../permissions/reviewer-models";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";
import { requestUiPick } from "./ui-requests";

const paramsSchema = z.strictObject({
	action: z.enum(["pick", "status", "off"]).default("pick"),
});
const reviewerId = (reviewer: RegisteredReviewModel) =>
	`${reviewer.provider}/${reviewer.model}`;

const oneChoice = (result: { ids: string[] }): string | undefined =>
	Array.isArray(result.ids) && result.ids.length === 1
		? result.ids[0]
		: undefined;

export const supportsLocalAutoReviewConfiguration = (state: RuntimeState) =>
	state.effectiveEnvironment.sourcePreset === "tui-local" &&
	!state.effectiveEnvironment.adapters.approvalReviewer &&
	process.geteuid !== undefined;

export const handleAutoReview = async (
	state: RuntimeState,
	id: string,
	raw: unknown,
): Promise<void> => {
	const fail = (
		message: string,
		code: RpcErrorCode = RPC_ERROR_CODE.INVALID_PARAMS,
	) => sendError(id, { code, message });
	if (!supportsLocalAutoReviewConfiguration(state))
		return fail(
			"Local Auto approve settings are unavailable.",
			RPC_ERROR_CODE.METHOD_NOT_FOUND,
		);
	const params = paramsSchema.safeParse(raw === undefined ? {} : raw);
	if (!params.success)
		return fail("Expected Auto approve action pick, status or off.");
	const { action } = params.data;
	const workspace =
		state.runtimeSandboxRoot ?? state.runtimeWorkingDir ?? process.cwd();
	const local = runtimeLocalAutoReview(state);
	const status = async () =>
		sendResult(
			id,
			local.status(workspace, await reviewChatRouteForStatus(state, workspace)),
		);
	if (action === "status") return status();
	try {
		if (action === "off") {
			await state.withAdmissionLock(async () =>
				local.configuration(workspace).disable(),
			);
			return status();
		}
		if (state.activeRunId)
			return fail(
				"Wait for the current run to finish before configuring Auto approve.",
				RPC_ERROR_CODE.RUNTIME_BUSY,
			);
		if (!state.uiCapabilities?.supports_pick)
			return fail("Auto approve setup requires a client with picker support.");

		const config = local.configuration(workspace);
		const context = state.approvalContext();
		const signal = state.approvalSignal(config.signal);
		const modePick = await requestUiPick(
			state,
			{
				title: "Select an Auto approve mode",
				message: isCanonicalHomeWorkspaceSync(workspace)
					? "Enable confined Auto approve for your home directory. This session's workspace covers your entire home directory, including nested projects and shell config files."
					: "Enable confined Auto approve for this workspace.",
				items: [
					{
						id: "enable",
						label: "Enable in this workspace",
						detail: "Keep the existing review model settings",
					},
					{
						id: "follow",
						label: "Follow chat provider",
						detail:
							"Use the provider’s registered model for Auto approve when available",
					},
					{
						id: "pin",
						label: "Custom model",
						detail: "Keep one registered provider and model",
					},
				],
			},
			signal,
		);
		if (signal.aborted || !modePick || modePick.ids?.length === 0)
			return status();
		const mode = oneChoice(modePick);
		if (mode !== "enable" && mode !== "follow" && mode !== "pin")
			return fail("Select enable, follow or custom.");
		let reviewer: RegisteredReviewModel | undefined;
		if (mode === "pin") {
			const pick = await requestUiPick(
				state,
				{
					title: "Select an Auto approve model",
					message: "Use this model for Auto approve.",
					items: localReviewModels.map((entry) => ({
						id: reviewerId(entry),
						label: reviewModelLabel(entry),
					})),
				},
				signal,
			);
			if (signal.aborted || !pick || pick.ids?.length === 0) return status();
			reviewer = localReviewModels.find(
				(entry) => reviewerId(entry) === oneChoice(pick),
			);
			if (!reviewer) return fail("Select one registered Auto approve model.");
		}
		const saved = await state.withAdmissionLock(async () => {
			if (
				signal.aborted ||
				state.activeRunId ||
				state.approvalContext() !== context
			)
				return false;
			if (mode === "enable") config.enable();
			else
				config.select(
					reviewer ? { mode: "pin", reviewer } : { mode: "follow" },
				);
			return true;
		});
		if (!saved) return fail("Auto approve setup expired. Reopen the picker.");
		return status();
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "review_config_symlink_redirect")
			return fail(
				"Could not save Auto approve settings because the user config directory uses a symbolic link. Use a real directory at the default location or a config directory outside the workspace.",
			);
		if (code === "review_config_inside_workspace")
			return fail(
				"Could not save Auto approve settings because the user config directory is inside this workspace. Use the default home config or a config directory outside the workspace.",
			);
		if (code === "review_config_unsafe_directory")
			return fail(
				"Could not save Auto approve settings because the user config directory permissions or ownership are unsafe.",
			);
		if (code === "review_config_changed")
			return fail(
				"Auto approve settings changed while the picker was open. Reopen the picker.",
			);
		return fail(
			"Could not save Auto approve settings. Check the private user config or reopen the picker.",
		);
	}
};
