import path from "node:path";
import {
	RPC_ERROR_CODE,
	type SkillsListParams,
	type SkillsListResult,
} from "@codelia/protocol";
import { resolveSkillsConfig } from "../config";
import type { RuntimeState } from "../runtime-state";
import { SkillsResolver } from "../skills";
import { sendError, sendResult } from "./transport";

export type SkillsHandlersDeps = {
	state: RuntimeState;
	log: (message: string) => void;
};

export const createSkillsHandlers = ({
	state,
	log,
}: SkillsHandlersDeps): {
	handleSkillsList: (id: string, params: SkillsListParams) => Promise<void>;
} => {
	const handleSkillsList = async (
		id: string,
		params: SkillsListParams,
	): Promise<void> => {
		const requestedCwd = params?.cwd ? path.resolve(params.cwd) : undefined;
		const workingDir =
			requestedCwd ??
			state.runtimeWorkingDir ??
			state.lastUiContext?.cwd ??
			process.cwd();
		const forceReload = params?.force_reload ?? false;
		if (!forceReload) {
			const cachedCatalog = state.skillsCatalogByCwd.get(workingDir);
			if (cachedCatalog) {
				sendResult(id, {
					skills: cachedCatalog.skills,
					errors: cachedCatalog.errors,
					truncated: cachedCatalog.truncated,
				} satisfies SkillsListResult);
				return;
			}
		}

		const canReuseStateResolver =
			!requestedCwd || requestedCwd === state.runtimeWorkingDir;
		let resolver: SkillsResolver | null = canReuseStateResolver
			? state.skillsResolver
			: null;
		if (!resolver) {
			try {
				resolver = await SkillsResolver.create({
					workingDir,
					config: await resolveSkillsConfig(workingDir),
				});
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: `skills resolver init failed: ${String(error)}`,
				});
				return;
			}
			if (canReuseStateResolver) {
				state.skillsResolver = resolver;
				state.runtimeWorkingDir = workingDir;
			}
		}

		try {
			const catalog = await resolver.getCatalog({ forceReload });
			state.updateSkillsSnapshot(workingDir, resolver.getSnapshot());
			const result: SkillsListResult = {
				skills: catalog.skills,
				errors: catalog.errors,
				truncated: catalog.truncated,
			};
			sendResult(id, result);
		} catch (error) {
			log(`skills.list error: ${String(error)}`);
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: `skills list failed: ${String(error)}`,
			});
		}
	};

	return { handleSkillsList };
};
