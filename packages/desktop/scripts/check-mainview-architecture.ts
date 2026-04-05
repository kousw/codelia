import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const mainviewRoot = path.join(packageRoot, "src", "mainview");

const collectFiles = async (dir: string): Promise<string[]> => {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const resolved = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				return collectFiles(resolved);
			}
			return [resolved];
		}),
	);
	return files.flat();
};

const isTsFile = (filePath: string): boolean =>
	filePath.endsWith(".ts") || filePath.endsWith(".tsx");

const isComponentSurface = (filePath: string): boolean =>
	filePath.startsWith(path.join(mainviewRoot, "components")) ||
	filePath === path.join(mainviewRoot, "App.tsx");

const architectureViolations: string[] = [];

const main = async (): Promise<void> => {
	const mainviewFiles = (await collectFiles(mainviewRoot)).filter(isTsFile);

	for (const filePath of mainviewFiles) {
		const relativePath = path.relative(packageRoot, filePath);
		const source = await readFile(filePath, "utf8");

		if (isComponentSurface(filePath) && /\bViewState\b/u.test(source)) {
			architectureViolations.push(
				`${relativePath}: presentation surfaces must not reference ViewState directly.`,
			);
		}

		const importsCommitState =
			/import\s*\{[^}]*\bcommitState\b[^}]*\}\s*from\s*["'][^"']*desktop-store["']/u.test(
				source,
			);
		const isAllowedCommitStateFile =
			filePath.startsWith(path.join(mainviewRoot, "state", "actions")) ||
			filePath === path.join(mainviewRoot, "state", "desktop-store.ts");
		if (importsCommitState && !isAllowedCommitStateFile) {
			architectureViolations.push(
				`${relativePath}: commitState is restricted to the state layer.`,
			);
		}
	}

	if (architectureViolations.length > 0) {
		console.error("Mainview architecture check failed:\n");
		for (const violation of architectureViolations) {
			console.error(`- ${violation}`);
		}
		process.exitCode = 1;
		return;
	}

	console.log("Mainview architecture check passed.");
};

await main();
