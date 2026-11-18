import path from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";

// Pass argv through CreateProcess/CRT. This fixture invokes node.exe directly.
function quote(argument: string): string {
	return (
		'"' +
		argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/u, "$1$1") +
		'"'
	);
}

export function buildQualificationRequest(
	root: string,
	executable: string,
	system: string,
	profile: "development" | "investigation",
	mode: "tree" | "controls",
	args: string[],
	peer?: string,
): ContainerRequest {
	const at = (...parts: string[]) => path.join(root, ...parts);
	const writable = profile === "development";
	return {
		containment: { type: "processcontainer" },
		command: [executable, at("worker", "worker.mjs"), mode, root, ...args]
			.map(quote)
			.join(" "),
		environment: {
			SystemRoot: system,
			TEMP: at("scratch"),
			TMP: at("scratch"),
			...(peer ? { CODELIA_QUALIFICATION_PEER: peer } : {}),
		},
		inheritDefaultEnvironment: false,
		workingDirectory: at("workspace"),
		filesystem: {
			readonlyPaths: [
				path.dirname(executable),
				at("worker"),
				at("reference"),
				...(writable ? [] : [at("workspace")]),
			],
			readwritePaths: [at("scratch"), ...(writable ? [at("workspace")] : [])],
			deniedPaths: [at("workspace", "protected")],
			clearPolicyOnExit: true,
		},
		network: {
			egress: { default: "deny" },
			ingress: { default: "deny", hostLoopback: "deny" },
		},
		ui: { disable: true },
		timeoutMs: 20_000,
	};
}
