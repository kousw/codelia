import { startRuntime } from "./runtime";

void startRuntime().catch((error) => {
	console.error(`runtime startup failed: ${String(error)}`);
	process.exitCode = 1;
});
