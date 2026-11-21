import { realpathSync } from "node:fs";
import type { ShellInvocation } from "./shell-analysis";

const maxEnvironmentBytes = 32 * 1024;

// This process runs inside the same isolation as the service. A private
// stdin frame keeps environment values out of argv and the launcher environment.
const serviceBootstrap = `
const { readSync } = require("node:fs");
const { spawn } = require("node:child_process");
const frame = Buffer.alloc(${maxEnvironmentBytes});
let length = 0;
for (; length < frame.length; length++) {
  if (readSync(0, frame, length, 1, null) !== 1) process.exit(125);
  if (frame[length] === 10) break;
}
if (length === frame.length) process.exit(125);
const env = JSON.parse(frame.toString("utf8", 0, length));
const [executable, ...args] = process.argv.slice(1);
const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: "inherit" });
child.once("error", () => process.exit(126));
child.once("exit", (code) => process.exit(code === null ? 1 : code));
`;

export function prepareMcpServiceEnvironment(
	invocation: ShellInvocation,
	environment: Readonly<Record<string, string>>,
) {
	if (invocation.kind !== "argv")
		throw new Error("MCP service environment requires direct execution");
	const names = Object.keys(environment).sort();
	if (
		names.some(
			(name) =>
				!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
				typeof environment[name] !== "string" ||
				environment[name].includes("\0"),
		)
	)
		throw new Error("Invalid MCP service environment");
	const frame = `${JSON.stringify(environment)}\n`;
	if (Buffer.byteLength(frame) > maxEnvironmentBytes)
		throw new Error("MCP service environment is too large");
	return {
		frame,
		names,
		invocation: Object.freeze({
			kind: "argv",
			executable: realpathSync(process.execPath),
			args: Object.freeze([
				"-e",
				serviceBootstrap,
				"--",
				invocation.executable,
				...invocation.args,
			]),
		}) satisfies ShellInvocation,
	};
}
