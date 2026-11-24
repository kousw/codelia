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
	return actionArgs.some(
		(arg) =>
			destructiveCommands.has(path.basename(arg)) ||
			arg === "--delete" ||
			arg.startsWith("--delete-") ||
			arg === "--purge" ||
			arg === "--force-delete",
	);
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
