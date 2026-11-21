import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { LinuxRunscBackend } from "../src/permissions/linux-shell-backend";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	selectProtectedShellBackend,
} from "../src/permissions/shell-backend";

test("selection requires a registered platform backend or an explicit SDK adapter", () => {
	const adapter: ProtectedShellBackend = {
		supports: () => false,
		launch: () => {
			throw new Error("unexpected launch");
		},
	};
	for (const platform of ["darwin", "linux", "win32", "freebsd"] as const) {
		expect(
			selectProtectedShellBackend({ platform, allowStandard: true, adapter }),
		).toBe(adapter);
		expect(
			selectProtectedShellBackend({ platform, allowStandard: false }),
		).toBeUndefined();
	}
	expect(
		selectProtectedShellBackend({ platform: "darwin", allowStandard: true }),
	).toBeInstanceOf(MacSeatbeltBackend);
	expect(
		selectProtectedShellBackend({ platform: "linux", allowStandard: true }),
	).toBeInstanceOf(LinuxRunscBackend);
	for (const platform of ["win32", "freebsd"] as const)
		expect(
			selectProtectedShellBackend({ platform, allowStandard: true }),
		).toBeUndefined();
});

test("partial or failed backend capability checks block before confirmation or launch", async () => {
	const root = realpathSync(tmpdir());
	let confirmations = 0;
	let launches = 0;
	let reviews = 0;
	const dispatcher = new ApprovalDispatcher({
		confirmation: {
			confirm: async () => {
				confirmations++;
				return null;
			},
		},
		review: {
			categories: ["local_test"],
			buildEvidence: async () => {
				reviews++;
				return null;
			},
			review: async () => {
				throw new Error("unexpected review send");
			},
		},
	});
	const backend: ProtectedShellBackend = {
		supportsReadOnlyPaths: true,
		supports: (protection) => protection.profile === "investigation",
		supportsInvocation: (invocation) => {
			if (invocation.kind === "argv") throw new Error("probe unavailable");
			return false;
		},
		launch: () => {
			launches++;
			throw new Error("unexpected launch");
		},
	};
	const authorize = createShellAuthorizer({
		root,
		backend,
		dispatcher,
		authority: {
			investigation: true,
			workspaceWrite: "granted",
			stdinPipe: "forbid",
		},
		// Resolve a real executable for admission on every test platform.
		resolveSource: (source) => ({
			kind: "source",
			executable: realpathSync(process.execPath),
			source,
			options: [],
			dialect: "bash",
		}),
	});
	for (const request of [
		{ source: "pwd" },
		{ source: "bun test" },
		{ argv: [process.execPath, "-e", ""] },
	] as const) {
		await expect(
			authorize({ ...request, cwd: root, origin: "parent_agent" }, (admit) =>
				admit(),
			),
		).rejects.toThrow("sandbox_unavailable");
	}
	expect([confirmations, reviews, launches]).toEqual([0, 0, 0]);
});

test("a backend losing exact invocation support during task admission never launches", async () => {
	const root = realpathSync(tmpdir());
	const executable = realpathSync(process.execPath);
	let available = true;
	let confirmations = 0;
	let launches = 0;
	const authorize = createShellAuthorizer({
		root,
		dispatcher: new ApprovalDispatcher({
			confirmation: {
				confirm: async ({ requestId }) => {
					confirmations++;
					return { requestId, choice: "allow_once" };
				},
			},
		}),
		backend: {
			supportsReadOnlyPaths: true,
			supports: () => true,
			supportsInvocation: (invocation, protection) =>
				available &&
				invocation.kind === "argv" &&
				invocation.executable === executable &&
				invocation.args[1] === "/* fixture */" &&
				protection.stdin === "closed",
			launch: () => {
				launches++;
				throw new Error("unexpected launch");
			},
		},
	});
	await expect(
		authorize(
			{
				argv: [executable, "-e", "/* fixture */"],
				cwd: root,
				origin: "parent_agent",
			},
			(admit) => {
				available = false;
				return admit();
			},
		),
	).rejects.toThrow("sandbox_unavailable");
	expect([confirmations, launches]).toEqual([1, 0]);
});
