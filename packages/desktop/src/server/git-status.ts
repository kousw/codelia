import { execFile } from "node:child_process";

const runGit = async (
	workspacePath: string,
	args: string[],
): Promise<string | null> =>
	new Promise((resolve) => {
		execFile("git", args, { cwd: workspacePath }, (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			resolve(stdout.trim() || null);
		});
	});

export const readGitStatus = async (
	workspacePath: string,
): Promise<{ branch: string | null; isDirty: boolean }> => {
	const branch =
		(await runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
		null;
	const porcelain =
		(await runGit(workspacePath, [
			"status",
			"--porcelain",
			"--untracked-files=no",
		])) ?? "";
	return {
		branch,
		isDirty: porcelain.trim().length > 0,
	};
};
