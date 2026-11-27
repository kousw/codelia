import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Operate only on the synthetic resources supplied by the qualification driver.
const [mode, root = "", ...args] = process.argv.slice(2);
const direct =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const workspace = path.join(root, "workspace");
const sentinel = "codelia-fixture";
const report = (value) => console.log(JSON.stringify(value));

export function tryConnection(target) {
	return new Promise((resolve) => {
		const socket = connect(target);
		const finish = (state) => {
			socket.destroy();
			resolve(state);
		};
		socket.setTimeout(1500, () => finish("timeout"));
		socket.once("connect", () => finish("connected"));
		socket.once("error", (error) => finish(error.code ?? "unknown"));
	});
}

function access(operation) {
	try {
		operation();
		return "allowed";
	} catch (error) {
		return error.code ?? "unknown";
	}
}

if (direct && mode === "controls") {
	const [port, pipe, ...argv] = args;
	const read = (name) => {
		if (readFileSync(name, "utf8") !== sentinel) throw new Error("bad fixture");
	};
	const [peer, peerPort] = (
		process.env.CODELIA_TEST_QUALIFICATION_PEER ?? ""
	).split(":");
	report({
		argv,
		cwdMatches: process.cwd().toLowerCase() === workspace.toLowerCase(),
		hostSentinelInherited:
			process.env.CODELIA_TEST_MXC_HOST_SENTINEL !== undefined,
		workspaceWrite: access(() =>
			writeFileSync(path.join(workspace, "output"), sentinel),
		),
		scratchWrite: access(() =>
			writeFileSync(path.join(root, "scratch", "output"), sentinel),
		),
		workspaceRead: access(() => read(path.join(workspace, "input"))),
		explicitRead: access(() => read(path.join(root, "reference", "input"))),
		referenceWrite: access(() =>
			writeFileSync(path.join(root, "reference", "output"), sentinel),
		),
		privateRead: access(() => read(path.join(workspace, "protected", "input"))),
		privateWrite: access(() =>
			writeFileSync(path.join(workspace, "protected", "output"), sentinel),
		),
		hostAclRead: access(() => read(path.join(root, "acl-baseline", "input"))),
		hostAclWrite: access(() =>
			writeFileSync(path.join(root, "acl-baseline", "output"), sentinel),
		),
		loopback: await tryConnection({ host: "127.0.0.1", port: Number(port) }),
		namedPipe: await tryConnection({ path: pipe }),
		peer: peer
			? await tryConnection({ host: peer, port: Number(peerPort) })
			: "untested",
	});
} else if (direct && mode === "tree") {
	const child = spawn(
		process.execPath,
		[fileURLToPath(import.meta.url), "leaf", root],
		{
			stdio: "ignore",
		},
	);
	child.on("error", () => {
		process.exitCode = 2;
	});
	await delay(12_000);
} else if (direct && mode === "leaf") {
	writeFileSync(path.join(root, "scratch", "leaf"), String(process.pid));
	await delay(10_000);
}
