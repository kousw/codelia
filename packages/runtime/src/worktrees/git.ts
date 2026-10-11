import type { CommandRunner } from "../lanes/command";

/** Shared primitive only: no mux, agent launch, cleanup or branch reset. */
export const addGitWorktree = async (
	runner: CommandRunner,
	input: {
		root: string;
		branch: string;
		path: string;
		base: string;
		safeCheckout?: boolean;
	},
): Promise<void> => {
	await runner("git", [
		...(input.safeCheckout
			? [
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"submodule.recurse=false",
				]
			: []),
		"-C",
		input.root,
		"worktree",
		"add",
		...(input.safeCheckout ? ["--no-checkout"] : []),
		"-b",
		input.branch,
		input.path,
		input.base,
	]);
	if (input.safeCheckout) {
		const prefix = [
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"submodule.recurse=false",
			"-C",
			input.path,
		];
		// Read destination-specific includes/worktree config before populating files.
		const keys = (
			await runner("git", [...prefix, "config", "--name-only", "--list"])
		).stdout;
		if (hasCheckoutFilters(keys))
			throw new Error("Automatic checkout filters are disabled");
		await runner("git", [...prefix, "read-tree", "--reset", "-u", input.base]);
	}
};

export const hasCheckoutFilters = (keys: string): boolean =>
	keys
		.split("\n")
		.some((key) => /^filter\..*\.(process|smudge|clean)$/i.test(key));
