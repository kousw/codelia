export const tuiPlatforms = new Map(
	["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"].map(
		(target) => [
			target,
			{
				packageDir: `packages/tui/${target}`,
				binaryName: target.startsWith("win32-")
					? "codelia-tui.exe"
					: "codelia-tui",
				includesMxc:
					target === "darwin-arm64" ||
					target === "linux-arm64" ||
					target === "linux-x64",
			},
		],
	),
);
