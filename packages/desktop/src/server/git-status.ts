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

const runGitChecked = async (
	workspacePath: string,
	args: string[],
): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile("git", args, { cwd: workspacePath }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
				return;
			}
			resolve(stdout.trim());
		});
	});

export const readGitStatus = async (
	workspacePath: string,
): Promise<{ branch: string | null; branches: string[]; isDirty: boolean }> => {
	const branch =
		(await runGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
		null;
	const branches = (
		(await runGit(workspacePath, [
			"branch",
			"--format=%(refname:short)",
			"--sort=-committerdate",
		])) ?? ""
	)
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);
	const porcelain =
		(await runGit(workspacePath, [
			"status",
			"--porcelain",
			"--untracked-files=no",
		])) ?? "";
	return {
		branch,
		branches,
		isDirty: porcelain.trim().length > 0,
	};
};

export const switchGitBranch = async (
	workspacePath: string,
	branch: string,
): Promise<void> => {
	if (!/^[^\s~^:?*[\\]+(?:\/[^\s~^:?*[\\]+)*$/.test(branch)) {
		throw new Error("Invalid branch name");
	}
	await runGitChecked(workspacePath, ["switch", "--", branch]);
};
