import path from "node:path";
import type { ShellAnalysis, ShellOperation } from "./shell-analysis";

type CommandOperation = Pick<ShellOperation, "argv">;

const bareFile = (value: string): boolean => !!value && !value.startsWith("-");
const readCommands = new Set([
	"pwd",
	"true",
	"false",
	"uname",
	"whoami",
	"date",
]);
const systemName = (value: string): string =>
	value === `/usr/bin/${path.basename(value)}` ||
	value === `/bin/${path.basename(value)}`
		? path.basename(value)
		: value;

const builtinRead = ({ argv }: CommandOperation): boolean => {
	const [executable, ...args] = argv;
	if (executable === "set") return args.length === 1 && args[0] === "-e";
	// Classify only the parsed command shape. The authorizer separately binds
	// executable identity before using this result to skip confirmation.
	const name = systemName(executable);
	if (readCommands.has(name)) return args.length === 0;
	if (name === "wc" || name === "cat") {
		const files = name === "wc" && args[0] === "-l" ? args.slice(1) : args;
		return files.length > 0 && files.every(bareFile);
	}
	if (name === "ls")
		return args.every((arg) => /^-[1t]+$/u.test(arg) || bareFile(arg));
	if (name === "head" || name === "tail") {
		const count = /^-\d+$/u.test(args[0] ?? "")
			? 1
			: args[0] === "-n" && /^\d+$/u.test(args[1] ?? "")
				? 2
				: 0;
		return args.slice(count).every(bareFile);
	}
	if (name === "sed") {
		return (
			args.length >= 2 &&
			args[0] === "-n" &&
			/^[1-9]\d*(?:,[1-9]\d*)?p$/u.test(args[1]) &&
			args.slice(2).every(bareFile)
		);
	}
	if (name === "echo") return args.every(bareFile);
	if (name === "printf") {
		const [format, ...values] = args;
		return (
			!!format &&
			!format.startsWith("-") &&
			!format.replaceAll("%s", "").includes("%") &&
			values.every(bareFile)
		);
	}
	if (name === "rg" || name === "grep") {
		const pureFlags = new Set([
			"-n",
			"-i",
			"-F",
			"-l",
			...(name === "grep" ? ["-E", "-nE", "-En"] : []),
			"--line-number",
			"--ignore-case",
			"--fixed-strings",
			"--files-with-matches",
		]);
		if (name === "rg" && args.length === 1 && args[0] === "--version")
			return true;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--") return index + 1 < args.length;
			if (name === "rg" && (arg === "-g" || arg === "--glob")) {
				if (!args[++index] || !bareFile(args[index])) return false;
				continue;
			}
			if (name === "rg" && ["--files", "--hidden"].includes(arg)) continue;
			if (!pureFlags.has(arg) && !bareFile(arg)) return false;
		}
		return args.length > 0;
	}
	return false;
};

// Read-only Git queries can run with only private scratch writable. Git's
// repository configuration remains subject to the ordinary launch approval.
const gitInspection = ({
	argv: [program, subcommand, ...args],
}: CommandOperation): boolean => {
	if (systemName(program) !== "git") return false;
	return (
		subcommand === "status" ||
		(subcommand === "log" &&
			args.every((arg) =>
				/^-\d+$|^--date=short$|^--format=[a-zA-Z0-9 %._-]+$/u.test(arg),
			)) ||
		(subcommand === "worktree" && args[0] === "list" && args.length === 1) ||
		(subcommand === "diff" &&
			!args.some((arg) => arg === "--output" || arg.startsWith("--output=")))
	);
};

const destructiveCommands = new Set([
	"rm",
	"rmdir",
	"dd",
	"shred",
	"truncate",
	"mkfs",
	"diskutil",
	"fdisk",
	"mv",
	"chmod",
	"chown",
	"kill",
	"killall",
	"pkill",
	"shutdown",
	"reboot",
]);
const networkCommands = new Set([
	"curl",
	"wget",
	"ssh",
	"scp",
	"sftp",
	"rsync",
	"nc",
	"netcat",
	"telnet",
	"kubectl",
	"terraform",
	"docker",
	"podman",
	"gh",
	"aws",
	"gcloud",
	"az",
]);
const indirectCommands = new Set([
	"sh",
	"bash",
	"zsh",
	"fish",
	"dash",
	"cmd",
	"pwsh",
	"powershell",
	"eval",
	"exec",
	"env",
	"command",
	"source",
	".",
	"builtin",
	"enable",
	"alias",
	"export",
	"unset",
	"trap",
	"read",
	"set",
	"printf",
	"find",
	"xargs",
	"sudo",
	"su",
	"doas",
	"nice",
	"nohup",
	"timeout",
	"time",
	"watch",
	"pushd",
	"popd",
	"awk",
	"sed",
	"perl",
	"ruby",
	"lua",
	"npx",
	"bunx",
	"osascript",
]);
const destructiveActions = new Set([
	"clean",
	"reset",
	"delete",
	"remove",
	"destroy",
	"uninstall",
	"prune",
]);
const externalActions = new Set([
	"push",
	"publish",
	"unpublish",
	"deploy",
	"release",
	"upload",
	"login",
]);

type ShellHumanReason =
	| "destructive"
	| "external_mutation"
	| "indirect_execution";

const destructiveHttpMethods = new Set(["delete", "purge", "drop"]);

function hasDestructiveEffect(operation: CommandOperation): boolean {
	if (builtinRead(operation)) return false;
	const [program, ...args] = operation.argv;
	const name = path.basename(program);
	if (destructiveCommands.has(name)) return true;
	const actionArgs = name === "cargo" && args[0] === "test" ? [] : args;
	const actionWords = [
		name,
		...actionArgs.filter(
			(arg) => !arg.startsWith("-") && !arg.includes("/") && !arg.includes("."),
		),
	].flatMap((word) => word.toLowerCase().split(/[.:_-]/u));
	if (actionWords.some((word) => destructiveActions.has(word))) return true;
	for (let i = 0; i < actionArgs.length; i += 1) {
		const arg = actionArgs[i];
		const lower = arg.toLowerCase();
		if (
			destructiveCommands.has(path.basename(arg)) ||
			lower === "--delete" ||
			lower.startsWith("--delete-") ||
			lower === "--purge" ||
			lower === "--force-delete"
		)
			return true;
		if (lower === "-x" || lower === "--request" || lower === "--method") {
			const method = actionArgs[i + 1]?.toLowerCase();
			if (method && destructiveHttpMethods.has(method)) return true;
		}
		const inlineMethod = /^(?:-x|--(?:request|method)=)([a-z]+)$/iu
			.exec(arg)?.[1]
			?.toLowerCase();
		if (inlineMethod && destructiveHttpMethods.has(inlineMethod)) return true;
	}
	return false;
}

export type InterpreterScriptTarget =
	| { kind: "none" }
	| { kind: "script"; operand: string }
	| { kind: "uninspectable" };

const pythonValueFlags = new Set(["-W", "-X"]);
const nodeValueFlags = new Set([
	"-C",
	"--conditions",
	"--env-file",
	"--env-file-if-exists",
	"--input-type",
	"--loader",
	"--experimental-loader",
	"--redirect-warnings",
	"--title",
]);
const bunSubcommands = new Set([
	"test",
	"build",
	"install",
	"i",
	"add",
	"remove",
	"rm",
	"update",
	"pm",
	"init",
	"upgrade",
	"link",
	"unlink",
	"outdated",
	"audit",
	"why",
]);

export function extractInterpreterScriptTarget(
	operation: CommandOperation,
): InterpreterScriptTarget {
	const [program, ...args] = operation.argv;
	const name = path.basename(program);
	if (name === "python" || name === "python3") {
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "--") {
				const next = args[i + 1];
				return next ? { kind: "script", operand: next } : { kind: "none" };
			}
			if (arg === "-") return { kind: "uninspectable" };
			if (arg === "-m" || arg.startsWith("-m") || arg === "-c")
				return { kind: "uninspectable" };
			if (pythonValueFlags.has(arg)) {
				i += 1;
				continue;
			}
			if (arg.startsWith("-")) continue;
			return { kind: "script", operand: arg };
		}
		return { kind: "none" };
	}
	if (name === "node") {
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "--") {
				const next = args[i + 1];
				return next ? { kind: "script", operand: next } : { kind: "none" };
			}
			if (arg === "-") return { kind: "uninspectable" };
			if (nodeValueFlags.has(arg)) {
				i += 1;
				continue;
			}
			if (arg.startsWith("-")) continue;
			return { kind: "script", operand: arg };
		}
		return { kind: "none" };
	}
	if (name === "deno") {
		if (args[0] !== "run") return { kind: "none" };
		for (let i = 1; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "--") {
				const next = args[i + 1];
				return next ? { kind: "script", operand: next } : { kind: "none" };
			}
			if (arg === "-") return { kind: "uninspectable" };
			if (arg.startsWith("-")) continue;
			if (/^https?:\/\//iu.test(arg)) return { kind: "uninspectable" };
			return { kind: "script", operand: arg };
		}
		return { kind: "none" };
	}
	if (name === "bun") {
		const start = args[0] === "run" ? 1 : 0;
		for (let i = start; i < args.length; i += 1) {
			const arg = args[i];
			if (arg === "--") {
				const next = args[i + 1];
				return next ? { kind: "script", operand: next } : { kind: "none" };
			}
			if (arg === "-") return { kind: "uninspectable" };
			if (arg.startsWith("-")) continue;
			if (start === 0 && bunSubcommands.has(arg)) return { kind: "none" };
			if (
				arg.includes("/") ||
				arg.includes("\\") ||
				/\.(?:[cm]?[jt]sx?)$/iu.test(arg)
			)
				return { kind: "script", operand: arg };
			return { kind: "none" };
		}
		return { kind: "none" };
	}
	return { kind: "none" };
}

function classifyOperation(
	operation: CommandOperation,
	indirect: boolean,
): ShellHumanReason | undefined {
	const [program, ...args] = operation.argv;
	const name = path.basename(program);
	if (builtinRead(operation)) return undefined;
	if (destructiveCommands.has(name)) return "destructive";
	if (networkCommands.has(name)) return "external_mutation";
	// Cargo has already selected the test subcommand in this form. Its remaining
	// words are operands, not operation names. Indirect execution is checked separately.
	const actionArgs = name === "cargo" && args[0] === "test" ? [] : args;
	// For other forms, retain the conservative scan for verbs after global flags.
	const actionWords = [
		name,
		...actionArgs.filter(
			(arg) => !arg.startsWith("-") && !arg.includes("/") && !arg.includes("."),
		),
	].flatMap((word) => word.toLowerCase().split(/[.:_-]/u));
	if (actionWords.some((word) => externalActions.has(word)))
		return "external_mutation";
	if (actionWords.some((word) => destructiveActions.has(word)))
		return "destructive";
	return indirect ? "indirect_execution" : undefined;
}

function isIndirectExecution(operation: CommandOperation): boolean {
	if (builtinRead(operation)) return false;
	const [program, ...args] = operation.argv;
	const name = path.basename(program);
	if (name === "cargo") {
		// Cargo accepts configuration overrides around subcommands. They can
		// select a runner or wrapper. After the separator, args are forwarded.
		for (const arg of args) {
			if (arg === "--") break;
			if (arg === "--config" || arg.startsWith("--config=")) return true;
		}
	}
	if (
		indirectCommands.has(name) ||
		(["npm", "pnpm", "yarn", "bun"].includes(name) &&
			args.some((arg) => ["exec", "x", "dlx", "create"].includes(arg))) ||
		(["python", "python3", "node", "bun", "deno"].includes(name) &&
			args.some((arg) =>
				/^(?:-[cepr].*|--(?:eval|print|require|import)(?:=|$))/u.test(arg),
			)) ||
		args.some((arg) =>
			/^(?:-c|-e|--eval|--exec|--execute|--pre|--shell|--config-env)(?:=|$)/u.test(
				arg,
			),
		)
	)
		return true;
	// The behavior of other modes of these read tools depends on option semantics.
	if (
		["rg", "grep", "sort"].includes(name) &&
		args.some((arg) =>
			/^(?:--pre|--pre-glob|--compress-program)(?:=|$)/u.test(arg),
		)
	)
		return true;
	// Git can load arbitrary command aliases; limit model review to known local subcommands.
	return (
		name === "git" &&
		!gitInspection(operation) &&
		!["status", "diff", "log", "show", "ls-files", "rev-parse"].includes(
			args[0],
		)
	);
}

/** A parsed, unregistered command may be reviewed for this launch inside its OS boundary.
 * Only these bounded operations can also be considered under login-user access.
 */
export function classifyShellOperations(
	analysis: Pick<ShellAnalysis, "opaque" | "compound"> & {
		operations: readonly CommandOperation[];
	},
) {
	const operations = analysis.operations.map((operation) => {
		const indirect = isIndirectExecution(operation);
		return {
			operation,
			reason: classifyOperation(operation, indirect),
			indirect,
		};
	});
	const reasons = new Set(operations.map(({ reason }) => reason));
	const indirectOperations = operations
		.filter(({ indirect }) => indirect)
		.map(({ operation }) => operation);
	const humanOnly = (
		["destructive", "external_mutation", "indirect_execution"] as const
	).find((reason) => reasons.has(reason));
	const localRead = !analysis.opaque && analysis.operations.every(builtinRead);
	const fullAccessInspectable =
		!analysis.opaque &&
		!analysis.compound &&
		analysis.operations.length === 1 &&
		analysis.operations.every(({ argv: [program, ...args] }) => {
			const name = systemName(program);
			return (
				(readCommands.has(name) && args.length === 0) ||
				(name === "uname" && args.length === 1 && /^-[asnrmvp]$/u.test(args[0]))
			);
		});
	const investigation =
		!analysis.opaque &&
		analysis.operations.every(
			(operation) => builtinRead(operation) || gitInspection(operation),
		);
	const hasDestructive = analysis.operations.some(hasDestructiveEffect);
	return {
		humanOnly,
		hasDestructive,
		indirectExecution: indirectOperations.length > 0,
		indirectOperations,
		localRead,
		investigation,
		fullAccessInspectable,
	};
}

/** Check only literal forms whose behavior is known for a bound system executable. */
export function hasNonExecutingOperands({
	argv: [program, ...args],
}: CommandOperation): boolean {
	switch (path.basename(program)) {
		case "find": {
			if (!bareFile(args[0] ?? "")) return false;
			for (let index = 1; index < args.length; index++) {
				const word = args[index];
				if (["-print", "-print0", "-empty"].includes(word)) continue;
				if (
					!["-name", "-iname", "-path", "-type"].includes(word) ||
					args[++index] === undefined
				)
					return false;
			}
			return true;
		}
		case "rg":
			return (
				args[0] === "-e" && args.length >= 2 && args.slice(2).every(bareFile)
			);
		case "awk":
			return (
				/^\{\s*print\s+\$\d+(?:\s*,\s*\$\d+)*\s*\}$/u.test(args[0] ?? "") &&
				args.slice(1).every(bareFile)
			);
		default:
			return false;
	}
}
