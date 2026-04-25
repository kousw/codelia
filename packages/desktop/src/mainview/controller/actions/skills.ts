import type { DesktopSkillSummary } from "../../../shared/types";
import { rpc } from "../runtime";

export const loadSkillsForComposer = async (
	workspacePath: string,
): Promise<DesktopSkillSummary[]> => {
	const result = await rpc.request.getSkills({
		workspace_path: workspacePath,
	});
	return result.skills;
};
