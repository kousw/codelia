import type { PermissionRule } from "@codelia/config";
import {
	analyzeShell,
	type ShellInvocation,
	singleCommandWords,
} from "./shell-analysis";
import { isShellPermissionRule, matchCommandGlob } from "./utils";

const trailingArgs = /[ \t]+\*$/u;

/** A direct-argv request has no shell source. Retain word boundaries in its glob representation. */
const quoteArg = (word: string): string =>
	/^[A-Za-z0-9_.,/+:%=@-]+$/u.test(word)
		? word
		: `'${word.replaceAll("'", "'\\''")}'`;

/** Apply the old rule language only after the runtime has bound a single invocation. */
export function matchesShellAllow(
	rule: PermissionRule,
	words: readonly string[],
	source?: string,
): boolean {
	if (!isShellPermissionRule(rule)) return false;
	if (rule.command !== undefined) {
		const invocation: ShellInvocation = {
			kind: "source",
			dialect: "bash",
			executable: "",
			options: [],
			source: rule.command.trim().replace(trailingArgs, ""),
		};
		const prefix = singleCommandWords(invocation, analyzeShell(invocation));
		if (!prefix?.every((word, index) => words[index] === word)) return false;
	}
	if (rule.command_glob === undefined) return true;
	const pattern = rule.command_glob.trim();
	if (!pattern) return false;
	// Legacy globs see a single space between shell words. Preserve spaces
	// in literal quoted arguments and keep argv without source unambiguous.
	const text =
		source === undefined
			? words.map(quoteArg).join(" ")
			: source
					.trim()
					.replace(
						/('[^']*'|"[^"]*")|[ \t]+/gu,
						(_text, quote: string | undefined) => quote ?? " ",
					);
	return (
		matchCommandGlob(text, pattern) ||
		(trailingArgs.test(pattern) &&
			matchCommandGlob(text, pattern.replace(trailingArgs, "")))
	);
}
