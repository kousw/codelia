import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tuiPlatforms } from "./tui-platforms.mjs";

const key = `${process.platform}-${process.arch}`;
if (tuiPlatforms.get(key)?.includesMxc) {
	const manifest = fileURLToPath(
		new URL("../crates/mxc-launcher/Cargo.toml", import.meta.url),
	);
	const build = spawnSync(
		"cargo",
		["build", "--release", "--locked", "--manifest-path", manifest],
		{ stdio: "inherit" },
	);
	if (build.error) throw build.error;
	process.exitCode = build.status ?? 1;
} else {
	console.log(`MXC helper is not packaged for ${key}.`);
}
