const sandboxModes = new Set(["readonly", "workspace-write", "full-access"]);
const legacyModes = new Map([
	["minimal", "readonly"],
	["trusted", "workspace-write"],
	["full-access", "workspace-write"],
]);

export function parseSandboxOption(arg, next) {
	const equals = arg.indexOf("=");
	const consumesNext = equals === -1;
	const option = consumesNext ? arg : arg.slice(0, equals);
	const value = consumesNext ? next : arg.slice(equals + 1);
	if (option === "--sandbox-mode") {
		if (!sandboxModes.has(value)) {
			throw new Error(
				"--sandbox-mode must be one of: readonly|workspace-write|full-access",
			);
		}
		return { key: "sandboxMode", value, consumesNext };
	}
	if (option === "--approval-mode") {
		if (!legacyModes.has(value)) {
			throw new Error(
				"--approval-mode must be one of: minimal|trusted|full-access",
			);
		}
		return { key: "approvalMode", value, consumesNext };
	}
}

export const sandboxModeForLegacyApproval = (value) => legacyModes.get(value);
