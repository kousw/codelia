import { spawn } from "node:child_process";
import {
	ApprovalDispatcher,
	type ApprovalService,
} from "../../src/permissions/dispatch";
import {
	createShellAuthorizer,
	type ShellAuthorizer,
} from "../../src/permissions/shell-approval";
import type {
	ProtectedShellBackend,
	ShellChild,
} from "../../src/permissions/shell-backend";
import { shellPathForLaunch } from "../../src/permissions/shell-path";

export const fixtureShellAuthority = {
	investigation: true,
	workspaceWrite: "granted",
	stdinPipe: "granted",
} as const;

export const approveFixture: ApprovalService = {
	confirm: async ({ requestId }) => ({ requestId, choice: "allow_once" }),
};

// Only regression suites that supply fixed, trusted commands use this fixture.
// The native Seatbelt acceptance test uses the real backend.
export const fixtureShellBackend: ProtectedShellBackend = {
	supportsReadOnlyPaths: true,
	supportsCommandBinding: true,
	supports: () => true,
	supportsLaunchBinding: () => true,
	exactLaunchBindingId: "fixture/1",
	supportsExactLaunchBinding: () => true,
	launch: (invocation, protection) => {
		const args =
			invocation.kind === "source"
				? [...invocation.options, invocation.source]
				: [...invocation.args];
		return spawn(invocation.executable, args, {
			cwd: protection.cwd,
			env: { PATH: shellPathForLaunch(protection.binPaths) },
			stdio: [protection.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		}) as ShellChild;
	},
};

export const fixtureShellAuthorizer: ShellAuthorizer = (input, execute) =>
	createShellAuthorizer({
		root: input.cwd,
		backend: fixtureShellBackend,
		authority: fixtureShellAuthority,
		dispatcher: new ApprovalDispatcher({ confirmation: approveFixture }),
	})(input, execute);
