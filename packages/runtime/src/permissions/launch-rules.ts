import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import { z } from "zod";
import type { ApprovalOrigin } from "./route";
import {
	type ShellAnalysis,
	type ShellInvocation,
	singleCommandWords,
} from "./shell-analysis";
import { isWithin } from "./shell-backend";

type LegacyLaunchRule = Readonly<{
	id: string;
	template: "bun-test-file/v1" | "bun-typecheck/v1";
	project: string;
	executable: string;
	executableIdentity: string;
	origin: "parent_agent" | "operator";
	profile: "development";
	stdin: "closed";
}>;

export type LaunchRuleCandidate = Readonly<{
	rule: LegacyLaunchRule;
	description: string;
	target: string;
	operand: string;
	targetIdentity: string;
}>;

export type ExactLaunchRule = Readonly<{
	id: string;
	template: "exact-argv/v2";
	project: string;
	cwd: string;
	launchKind: ShellInvocation["kind"];
	argv0: string;
	source?: string;
	executable: string;
	executableIdentity: string;
	args: readonly string[];
	origin: "parent_agent" | "operator";
	profile: "development" | "investigation";
	stdin: "closed";
	authority: string;
}>;
export type PrefixLaunchRule = Omit<ExactLaunchRule, "template" | "source"> &
	Readonly<{ template: "argv-prefix/v1" }>;
export type LaunchRule = ExactLaunchRule | PrefixLaunchRule | LegacyLaunchRule;
export type ExactLaunchCandidate = Readonly<{
	rule: ExactLaunchRule;
	invocation: ShellInvocation;
	description: string;
}>;

export const fileIdentity = (file: string): string => {
	const stat = statSync(file, { bigint: true });
	if (!stat.isFile()) throw new Error("expected_regular_file");
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
};

// Render proposed authority as data, including paths containing newlines or
// directional controls. The model cannot supply any part of this description.
const displayLiteral = (value: string | readonly string[]): string =>
	JSON.stringify(value).replace(/[\p{Cf}\p{Cc}\u2028\u2029]/gu, (char) =>
		char
			.split("")
			.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join(""),
	);

// Ask the selected, runtime-owned Bash about its own language, including
// platform-specific builtins. No command or environment from the request runs.
let bashNames: { identity: string; names: Set<string> } | undefined;
function isExternalBashWord(shell: string, word: string): boolean {
	if (path.isAbsolute(word)) return true;
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u.test(word)) return false;
	const identity = fileIdentity(shell);
	if (bashNames?.identity !== identity) {
		const result = spawnSync(
			shell,
			["--noprofile", "--norc", "-c", "compgen -b; compgen -k"],
			{
				cwd: "/",
				env: {},
				encoding: "utf8",
				timeout: 1000,
				maxBuffer: 16384,
			},
		);
		if (result.status !== 0 || !result.stdout.includes("enable\n"))
			return false;
		bashNames = { identity, names: new Set(result.stdout.trim().split("\n")) };
	}
	return !bashNames.names.has(word);
}

export function exactCommandWords(
	invocation: ShellInvocation,
	analysis: ShellAnalysis,
): readonly string[] | undefined {
	const words = singleCommandWords(invocation, analysis);
	return words &&
		(invocation.kind === "argv" ||
			isExternalBashWord(invocation.executable, words[0]))
		? words
		: undefined;
}

export function buildExactLaunchCandidate(
	input: Omit<
		ExactLaunchRule,
		"id" | "template" | "executableIdentity" | "stdin" | "launchKind" | "source"
	>,
	invocation: ShellInvocation,
): ExactLaunchCandidate | undefined {
	const body = {
		template: "exact-argv/v2",
		...input,
		launchKind: invocation.kind,
		...(invocation.kind === "source" ? { source: invocation.source } : {}),
		args: Object.freeze([...input.args]),
		executableIdentity: fileIdentity(input.executable),
		stdin: "closed",
	} as const;
	const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	const rule = Object.freeze({ id, ...body });
	if (Buffer.byteLength(JSON.stringify(rule)) > 8192) return undefined;
	return {
		rule,
		invocation,
		description: `Exact command ${displayLiteral([rule.argv0, ...rule.args])} in ${displayLiteral(rule.cwd)} (${rule.profile}, ${rule.origin}, closed stdin). Bound executable: ${displayLiteral(rule.executable)}. The same ${invocation.kind === "source" ? "Bash source" : "direct argv"} is launched on reuse. Scripts, build/test inputs and their effects can change.`,
	};
}

const subcommandWord = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const suggestedRule = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("exact") }),
	z.strictObject({
		kind: z.literal("prefix"),
		words: z.array(z.string()).min(2),
	}),
]);
export type LaunchRuleSuggestion =
	| Readonly<{ kind: "exact" }>
	| Readonly<{ kind: "prefix"; words: readonly string[] }>;

function prefixRule(exact: ExactLaunchRule, length: number): PrefixLaunchRule {
	const {
		id: _id,
		template: _template,
		source: _source,
		args,
		...binding
	} = exact;
	const body = {
		template: "argv-prefix/v1" as const,
		...binding,
		args: Object.freeze(args.slice(0, length)),
	};
	const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	return Object.freeze({ id, ...body });
}

export function bindSuggestedLaunch(
	candidate: ExactLaunchCandidate,
	suggestion: unknown,
):
	| {
			rule: ExactLaunchRule | PrefixLaunchRule;
			description: string;
	  }
	| undefined {
	const parsed = suggestedRule.safeParse(suggestion);
	if (!parsed.success) return undefined;
	if (parsed.data.kind === "exact") return candidate;
	const [argv0, ...prefix] = parsed.data.words;
	if (
		argv0 !== candidate.rule.argv0 ||
		!prefix.every(
			(word, index) =>
				subcommandWord.test(word) && word === candidate.rule.args[index],
		)
	)
		return undefined;
	const rule = prefixRule(candidate.rule, prefix.length);
	return {
		rule,
		description: `Allow ${displayLiteral([rule.argv0, ...rule.args])} with any trailing arguments in ${displayLiteral(rule.cwd)} (${rule.profile}, ${rule.origin}, closed stdin). Bound executable: ${displayLiteral(rule.executable)}. Scripts, build/test inputs and their effects can change.`,
	};
}

/** Reconstruct the original v1 target and command binding from this request. */
export const legacyLocalTestEvidence = ({
	analysis,
	project,
	cwd,
	origin,
	stdin,
	executable,
}: {
	analysis: ShellAnalysis;
	project: string;
	cwd: string;
	origin: ApprovalOrigin;
	stdin: "closed" | "pipe";
	executable: string;
}): LaunchRuleCandidate | undefined => {
	if (
		analysis.opaque ||
		analysis.compound ||
		analysis.operations.length !== 1 ||
		cwd !== project ||
		stdin !== "closed" ||
		(origin !== "parent_agent" && origin !== "operator")
	)
		return undefined;
	const [command, action, arg, ...extra] = analysis.operations[0].argv;
	if (command !== "bun" || extra.length || !arg || arg.startsWith("-"))
		return undefined;
	try {
		let template: LegacyLaunchRule["template"];
		let target: string;
		let operand: string;
		let description: string;
		if (
			action === "test" &&
			arg.startsWith("./tests/") &&
			arg.endsWith(".test.ts")
		) {
			const tests = path.join(project, "tests");
			operand = arg;
			target = realpathSync(path.resolve(cwd, operand));
			if (!isWithin(tests, target) || !target.endsWith(".test.ts"))
				return undefined;
			template = "bun-test-file/v1";
			description =
				"One explicit ./tests/**/*.test.ts path, no flags, from the workspace root";
		} else if (action === "run" && arg === "typecheck") {
			operand = "package.json";
			target = realpathSync(path.resolve(cwd, operand));
			if (!isWithin(project, target)) return undefined;
			template = "bun-typecheck/v1";
			description =
				"Exact bun run typecheck from the workspace root. The project script can change.";
		} else return undefined;
		const body = {
			template,
			project,
			executable,
			executableIdentity: fileIdentity(executable),
			origin,
			profile: "development",
			stdin,
		} as const;
		const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
		return {
			rule: { id, ...body },
			description,
			target,
			operand,
			targetIdentity: fileIdentity(target),
		};
	} catch {
		return undefined;
	}
};

export class LaunchRuleStore {
	private readonly cached = new Map<
		string,
		{ revision: string; rule: LaunchRule }
	>();
	private readonly session = new Map<string, LaunchRule>();

	constructor(
		readonly directory = path.join(
			resolveStoragePaths().configDir,
			"launch-approvals",
		),
	) {}

	private projectDirectory(project: string): string {
		return path.join(
			this.directory,
			createHash("sha256").update(project).digest("hex"),
		);
	}

	private assertPrivate(directory: string): void {
		const info = lstatSync(directory);
		if (
			!info.isDirectory() ||
			(info.mode & 0o077) !== 0 ||
			(process.getuid && info.uid !== process.getuid())
		)
			throw new Error("invalid_launch_rule_store");
	}

	private read(directory: string, id: string): LaunchRule | undefined {
		if (!/^[a-f0-9]{64}$/u.test(id)) return undefined;
		try {
			this.assertPrivate(this.directory);
			this.assertPrivate(directory);
			const file = path.join(directory, id);
			const stat = lstatSync(file, { bigint: true });
			if (
				!stat.isFile() ||
				stat.size > 8192 ||
				(stat.mode & 0o077n) !== 0n ||
				(process.getuid && stat.uid !== BigInt(process.getuid()))
			)
				return undefined;
			const revision = `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.size}`;
			const current = this.cached.get(file);
			if (current?.revision === revision) return current.rule;
			const raw = readFileSync(file, "utf8");
			let parsed: LaunchRule;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return undefined;
			}
			if (
				parsed?.id !== id ||
				typeof parsed.project !== "string" ||
				typeof parsed.executable !== "string" ||
				(parsed.origin !== "parent_agent" && parsed.origin !== "operator")
			)
				return undefined;
			if (
				parsed.template === "exact-argv/v2" ||
				parsed.template === "argv-prefix/v1"
			) {
				if (
					!Array.isArray(parsed.args) ||
					!parsed.args.every((arg) => typeof arg === "string") ||
					typeof parsed.cwd !== "string" ||
					typeof parsed.argv0 !== "string" ||
					(parsed.profile !== "development" &&
						parsed.profile !== "investigation") ||
					(parsed.launchKind !== "argv" && parsed.launchKind !== "source") ||
					(parsed.template === "exact-argv/v2" &&
						parsed.launchKind === "source" &&
						typeof parsed.source !== "string") ||
					(parsed.template === "argv-prefix/v1" &&
						(!parsed.args.length ||
							!parsed.args.every((arg) => subcommandWord.test(arg))))
				)
					return undefined;
			} else if (
				parsed.template !== "bun-test-file/v1" &&
				parsed.template !== "bun-typecheck/v1"
			)
				return undefined;
			const rule = Object.freeze(parsed);
			this.cached.set(file, { revision, rule });
			return rule;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	has(rule: LaunchRule, session: string): boolean {
		if (rule.template !== "exact-argv/v2" && rule.template !== "argv-prefix/v1")
			return false;
		return this.stored(rule, session);
	}

	hasLegacy(rule: LegacyLaunchRule, session: string): boolean {
		const { id, ...body } = rule;
		if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== id)
			return false;
		return this.stored(rule, session);
	}

	private stored(rule: LaunchRule, session: string): boolean {
		const cache = this.session.get(JSON.stringify([session, rule.id]));
		if (cache && JSON.stringify(cache) === JSON.stringify(rule)) return true;
		try {
			const saved = this.read(this.projectDirectory(rule.project), rule.id);
			return !!saved && JSON.stringify(saved) === JSON.stringify(rule);
		} catch {
			return false;
		}
	}

	match(
		exact: ExactLaunchRule,
		session: string,
	): ExactLaunchRule | PrefixLaunchRule | undefined {
		if (this.has(exact, session)) return exact;
		// Probe only possible saved prefixes of this argv, independently of the
		// number of saved rules. Each lookup includes the current launch binding.
		for (
			let index = 0;
			index < exact.args.length && subcommandWord.test(exact.args[index]);
			index++
		) {
			const prefix = prefixRule(exact, index + 1);
			if (this.has(prefix, session)) return prefix;
		}
		return undefined;
	}

	save(rule: LaunchRule, scope: "session" | "project", session: string): void {
		if (scope === "session") {
			this.session.set(JSON.stringify([session, rule.id]), rule);
			return;
		}
		const directory = this.projectDirectory(rule.project);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		this.assertPrivate(this.directory);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.assertPrivate(directory);
		if (this.has(rule, session) && this.read(directory, rule.id)) return;
		const scratch = mkdtempSync(path.join(directory, ".pending-"));
		try {
			const file = path.join(scratch, "rule");
			writeFileSync(file, JSON.stringify(rule), {
				mode: 0o600,
				flag: "wx",
				flush: true,
			});
			try {
				linkSync(file, path.join(directory, rule.id));
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code !== "EEXIST" ||
					JSON.stringify(this.read(directory, rule.id)) !== JSON.stringify(rule)
				)
					throw error;
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	list(
		project: string,
		session: string,
	): Array<LaunchRule & { scope: "session" | "project" }> {
		const directory = this.projectDirectory(project);
		const sessionRules = [...this.session.entries()].flatMap(([key, rule]) =>
			key === JSON.stringify([session, rule.id]) && rule.project === project
				? [{ ...rule, scope: "session" as const }]
				: [],
		);
		try {
			this.assertPrivate(this.directory);
			this.assertPrivate(directory);
			const saved = readdirSync(directory).flatMap((id) => {
				const rule = this.read(directory, id);
				return rule?.project === project
					? [{ ...rule, scope: "project" as const }]
					: [];
			});
			return [...sessionRules, ...saved];
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return sessionRules;
			throw error;
		}
	}

	remove(
		project: string,
		session: string,
		id: string,
		scope: "session" | "project",
	): boolean {
		if (scope === "session") {
			const key = JSON.stringify([session, id]);
			return (
				this.session.get(key)?.project === project && this.session.delete(key)
			);
		}
		const directory = this.projectDirectory(project);
		if (!this.read(directory, id)) return false;
		try {
			const file = path.join(directory, id);
			unlinkSync(file);
			this.cached.delete(file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
}
