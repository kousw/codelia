import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StdioMcpClient } from "../src/mcp/client";

const createTrackableSignal = (): {
	signal: AbortSignal;
	getActiveListeners: () => number;
	getAddCalls: () => number;
	getRemoveCalls: () => number;
} => {
	const listeners = new Set<EventListenerOrEventListenerObject>();
	let addCalls = 0;
	let removeCalls = 0;
	const signalLike = {
		aborted: false,
		addEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
		) => {
			if (type !== "abort") return;
			addCalls += 1;
			listeners.add(listener);
		},
		removeEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
		) => {
			if (type !== "abort") return;
			removeCalls += 1;
			listeners.delete(listener);
		},
	};
	return {
		signal: signalLike as unknown as AbortSignal,
		getActiveListeners: () => listeners.size,
		getAddCalls: () => addCalls,
		getRemoveCalls: () => removeCalls,
	};
};

describe("StdioMcpClient abort listener cleanup", () => {
	test("removes abort listeners when requests time out", async () => {
		const trackedSignal = createTrackableSignal();
		const client = new StdioMcpClient({
			serverId: "srv",
			command: process.execPath,
			args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
			log: () => {},
		});

		try {
			for (let i = 0; i < 12; i += 1) {
				await expect(
					client.request(
						"tools/list",
						{},
						{
							timeoutMs: 10,
							signal: trackedSignal.signal,
						},
					),
				).rejects.toThrow("MCP request timed out");
			}

			expect(trackedSignal.getActiveListeners()).toBe(0);
			expect(trackedSignal.getRemoveCalls()).toBe(trackedSignal.getAddCalls());
		} finally {
			await client.close();
		}
	});
});

const testStubborn = process.platform === "win32" ? test.skip : test;
testStubborn("forces a server that ignores termination to exit", async () => {
	const client = new StdioMcpClient({
		serverId: "stubborn",
		command: process.execPath,
		args: [
			"-e",
			`
process.on("SIGTERM", () => {});
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
});
`,
		],
		log: () => {},
	});
	await client.request("initialize", {}, { timeoutMs: 2_000 });
	await Promise.all([client.close(), client.close()]);
	const child = (client as unknown as { child: { signalCode: string | null } })
		.child;
	expect(child.signalCode).toBe("SIGKILL");
});

testStubborn("terminates a wrapper's surviving MCP descendant", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-mcp-tree-"));
	const marker = path.join(root, "child-pid");
	const descendant = `
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(process.argv[1], String(process.pid));
setInterval(() => {}, 1000);
`;
	const wrapper = `
require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
});
`;
	const client = new StdioMcpClient({
		serverId: "wrapper",
		command: process.execPath,
		args: ["-e", wrapper, descendant, marker],
		log: () => {},
	});
	const child = (client as unknown as { child: { pid: number } }).child;
	try {
		await client.request("initialize", {}, { timeoutMs: 2_000 });
		let childPid = 0;
		for (let attempt = 0; attempt < 200 && !childPid; attempt++) {
			childPid = Number(await fs.readFile(marker, "utf8").catch(() => "0"));
			if (!childPid) await Bun.sleep(10);
		}
		expect(childPid).toBeGreaterThan(0);
		await client.close();
		let running = true;
		try {
			process.kill(childPid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false;
			else throw error;
		}
		if (process.platform === "linux" && running) {
			const stat = await fs
				.readFile(`/proc/${childPid}/stat`, "utf8")
				.catch(() => "");
			if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "))
				running = false;
		}
		expect(running).toBe(false);
	} finally {
		try {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		} catch {
			/* already exited */
		}
		await client.close().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});
