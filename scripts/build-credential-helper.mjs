import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
	const manifest = fileURLToPath(
		new URL("../crates/credential-helper/Cargo.toml", import.meta.url),
	);
	const build = spawnSync(
		"cargo",
		["build", "--release", "--locked", "--manifest-path", manifest],
		{ stdio: "inherit" },
	);
	if (build.error) throw build.error;
	process.exitCode = build.status ?? 1;
} else {
	console.log("Credential helper is shipped for macOS only.");
}
