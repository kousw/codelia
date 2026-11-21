export type ShellInvocation =
	| Readonly<{
			kind: "source";
			executable: string;
			dialect: "bash" | "unsupported";
			options: readonly string[];
			source: string;
	  }>
	| Readonly<{
			kind: "argv";
			executable: string;
			args: readonly string[];
	  }>;

export function shellInvocationArgs(invocation: ShellInvocation): string[] {
	return invocation.kind === "source"
		? [...invocation.options, invocation.source]
		: [...invocation.args];
}

type Word = Readonly<{
	start: number;
	end: number;
	text: string;
	style:
		| "bare"
		| "quoted"
		| "variable"
		| "unquoted_variable"
		| "brace_list"
		| "unknown";
}>;

export type ShellOperation = Readonly<{
	argv: readonly string[];
	span: readonly [number, number];
}>;

export type ShellAnalysis = Readonly<{
	operations: readonly ShellOperation[];
	opaque: boolean;
	compound: boolean;
	unknownSpan?: readonly [number, number];
	/** A literal command with ordinary word/glob arguments, without shell control flow. */
	singleStage?: true;
	stateChanges?: readonly Readonly<{
		kind: "errexit";
		span: readonly [number, number];
	}>[];
}>;

/** Require the entire invocation to consist of one fully resolved literal command. */
export function singleCommandWords(
	invocation: ShellInvocation,
	analysis: ShellAnalysis,
): readonly string[] | undefined {
	if (analysis.opaque || analysis.compound || analysis.operations.length !== 1)
		return undefined;
	const {
		span: [start, end],
		argv,
	} = analysis.operations[0];
	if (
		invocation.kind === "source" &&
		(invocation.source.slice(0, start).trim() ||
			invocation.source.slice(end).trim())
	)
		return undefined;
	return argv;
}

/** Every stage after the first is reached only if all preceding stages succeeded. */
export function isSimpleAndChain(
	source: string,
	analysis: ShellAnalysis,
): boolean {
	const { operations } = analysis;
	const last = operations.at(-1);
	if (analysis.opaque || !last || operations.length < 2) return false;
	// Gaps between parsed spans exclude alternate branches, pipelines, loop
	// headers and list separators without interpreting quoted arguments again.
	return (
		!source.slice(0, operations[0].span[0]).trim() &&
		/^[;\s]*$/u.test(source.slice(last.span[1])) &&
		operations
			.slice(1)
			.every(({ span }, index) =>
				/^\s*&&\s*$/u.test(source.slice(operations[index].span[1], span[0])),
			)
	);
}

const MAX_SOURCE_BYTES = 32 * 1024;
const MAX_TOKENS = 512;
const MAX_OPERATIONS = 128;
const MAX_DEPTH = 8;
const tokenPattern =
	/[ \t]+|\n|&&|\|\||[;|]|\$[A-Za-z_][A-Za-z_0-9]*|"[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_./-]*\{[A-Za-z0-9_./-]+(?:,[A-Za-z0-9_./-]+)+\}[A-Za-z0-9_./-]*|[A-Za-z0-9_.,/+:%=@-]+|[^\n]/gy;
const literalBraceList =
	/^([A-Za-z0-9_./-]*)\{([A-Za-z0-9_./-]+(?:,[A-Za-z0-9_./-]+)+)\}([A-Za-z0-9_./-]*)$/u;
// Keep environment and special shell variables outside the supported binding subset.
// Ordinary lower-case and camelCase names are scoped to this loop during analysis.
const ordinaryLoopVariable = /^[a-z][A-Za-z0-9_]*$/u;
const specialLowercaseVariables = new Set(["auto_resume", "histchars"]);
const reserved = new Set([
	"for",
	"in",
	"do",
	"done",
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"case",
	"esac",
	"while",
	"until",
	"function",
	"select",
	"time",
	"coproc",
	"!",
]);
const separators = new Set([";", "\n"]);
const connectors = new Set(["&&", "||", "|"]);

const lex = (source: string): Word[] => {
	const tokens: Word[] = [];
	let lastEnd = -1;
	for (const match of source.matchAll(tokenPattern)) {
		const raw = match[0];
		const start = match.index;
		const end = start + raw.length;
		if (/^[ \t]+$/u.test(raw)) continue;
		let word: Word = { start, end, text: raw, style: "bare" };
		if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
			word = { ...word, style: "quoted", text: raw.slice(1, -1) };
		} else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
			const text = raw.slice(1, -1);
			word = /^\$[A-Za-z_][A-Za-z_0-9]*$/u.test(text)
				? { ...word, text: text.slice(1), style: "variable" }
				: {
						...word,
						text,
						style: /[$`\\!]/u.test(text) ? "unknown" : "quoted",
					};
		} else if (/^\$[A-Za-z_][A-Za-z_0-9]*$/u.test(raw)) {
			word = { ...word, text: raw.slice(1), style: "unquoted_variable" };
		} else if (literalBraceList.test(raw)) {
			word = { ...word, style: "brace_list" };
		} else if (
			!separators.has(raw) &&
			!connectors.has(raw) &&
			!/^[A-Za-z0-9_.,/+:%=@-]+$/u.test(raw)
		) {
			word = { ...word, style: "unknown" };
		}
		const last = tokens.at(-1);
		if (
			last &&
			start === lastEnd &&
			!control(last, separators) &&
			!control(last, connectors) &&
			!control(word, separators) &&
			!control(word, connectors)
		) {
			const literalOption =
				last.style === "bare" &&
				/^--[a-z][a-z0-9-]*=$/u.test(last.text) &&
				word.style === "quoted";
			tokens[tokens.length - 1] = literalOption
				? {
						start: last.start,
						end,
						text: last.text + word.text,
						style: "quoted",
					}
				: {
						start: last.start,
						end,
						text: source.slice(last.start, end),
						style: "unknown",
					};
		} else {
			tokens.push(word);
		}
		lastEnd = end;
		if (tokens.length > MAX_TOKENS) throw new Error("token limit");
	}
	return tokens;
};

const control = (word: Word | undefined, set: ReadonlySet<string>): boolean =>
	word?.style === "bare" && set.has(word.text);

export const analyzeShell = (invocation: ShellInvocation): ShellAnalysis => {
	if (invocation.kind === "argv") {
		return {
			operations: [
				{ argv: [invocation.executable, ...invocation.args], span: [0, 0] },
			],
			compound: false,
			opaque: false,
		};
	}
	const source = invocation.source;
	const operations: ShellOperation[] = [];
	let compound = false;
	let tokens: Word[] = [];
	const opaque = (start = 0): ShellAnalysis => ({
		operations,
		compound,
		opaque: true,
		unknownSpan: [start, source.length],
		...(operations.length === 1 &&
		tokens[0]?.start === operations[0].span[0] &&
		tokens.every((word) =>
			word.style === "unknown"
				? /^[A-Za-z0-9_.,/+:%=@*?-]+$/u.test(word.text)
				: !control(word, connectors) && !control(word, separators),
		)
			? { singleStage: true }
			: {}),
	});
	if (
		invocation.dialect !== "bash" ||
		Buffer.byteLength(source) > MAX_SOURCE_BYTES ||
		source.includes("\0")
	)
		return opaque();

	let index = 0;
	const at = (text: string) =>
		tokens[index]?.style === "bare" && tokens[index]?.text === text;
	const take = (text: string) => {
		if (!at(text)) throw new Error("unsupported grammar");
		index++;
	};
	const skipNewlines = () => {
		while (at("\n")) index++;
	};
	const finishHeader = () => {
		if (at(";")) index++;
		else if (!at("\n")) throw new Error("expected terminator");
		skipNewlines();
	};

	const list = (
		stop: ReadonlySet<string>,
		bindings: ReadonlyMap<string, string>,
		depth: number,
	) => {
		if (depth > MAX_DEPTH) throw new Error("nesting limit");
		let count = 0;
		skipNewlines();
		while (index < tokens.length && !control(tokens[index], stop)) {
			const start = index;
			if (at("for")) {
				compound = true;
				take("for");
				const name = tokens[index++];
				if (
					name?.style !== "bare" ||
					!ordinaryLoopVariable.test(name.text) ||
					specialLowercaseVariables.has(name.text) ||
					bindings.has(name.text)
				)
					throw new Error("unsupported binding");
				take("in");
				const values: string[] = [];
				while (tokens[index] && !control(tokens[index], separators)) {
					const word = tokens[index++];
					if (word.style === "brace_list") {
						const [, prefix, entries, suffix] =
							literalBraceList.exec(word.text) ?? [];
						for (const entry of entries.split(",")) {
							if (values.length >= MAX_OPERATIONS)
								throw new Error("loop limit");
							values.push(prefix + entry + suffix);
						}
					} else if (word.style === "bare" || word.style === "quoted") {
						values.push(word.text);
					} else throw new Error("nonliteral loop");
					if (values.length > MAX_OPERATIONS) throw new Error("loop limit");
				}
				if (!values.length) throw new Error("empty loop");
				finishHeader();
				take("do");
				const body = index;
				for (const value of values) {
					index = body;
					list(
						new Set(["done"]),
						new Map(bindings).set(name.text, value),
						depth + 1,
					);
					take("done");
				}
			} else if (at("if")) {
				compound = true;
				take("if");
				list(new Set(["then"]), bindings, depth + 1);
				take("then");
				list(new Set(["else", "fi"]), bindings, depth + 1);
				if (at("else")) {
					take("else");
					list(new Set(["fi"]), bindings, depth + 1);
				}
				take("fi");
			} else {
				const argv: string[] = [];
				while (
					tokens[index] &&
					!control(tokens[index], separators) &&
					!control(tokens[index], connectors)
				) {
					const word = tokens[index++];
					const variable =
						word.style === "variable" || word.style === "unquoted_variable";
					const value = variable ? bindings.get(word.text) : word.text;
					if (
						word.style === "unknown" ||
						word.style === "brace_list" ||
						value === undefined ||
						(word.style === "unquoted_variable" &&
							!/^[a-zA-Z0-9_./-]+$/u.test(value)) ||
						(!argv.length &&
							(reserved.has(value) || value.includes("=") || variable))
					) {
						if (argv.length) append(argv, start, index - 1);
						throw new Error("unknown operation");
					}
					argv.push(value);
				}
				if (!argv.length || !argv[0]) throw new Error("empty operation");
				append(argv, start, index);
			}
			count++;
			if (count > 1) compound = true;
			if (control(tokens[index], connectors)) {
				compound = true;
				index++;
				skipNewlines();
				if (index === tokens.length || control(tokens[index], stop))
					throw new Error("incomplete list");
			} else if (control(tokens[index], separators)) {
				index++;
				skipNewlines();
			} else if (index < tokens.length) {
				throw new Error("missing terminator");
			}
		}
		if (!count) throw new Error("empty list");
	};
	const append = (argv: string[], start: number, end: number) => {
		if (operations.length >= MAX_OPERATIONS) throw new Error("operation limit");
		operations.push({ argv, span: [tokens[start].start, tokens[end - 1].end] });
	};
	try {
		tokens = lex(source);
		list(new Set(), new Map(), 0);
		const stateChanges = operations.flatMap(({ argv, span }) =>
			argv.length === 2 && argv[0] === "set" && argv[1] === "-e"
				? [{ kind: "errexit" as const, span }]
				: [],
		);
		return {
			operations,
			compound,
			opaque: false,
			...(stateChanges.length ? { stateChanges } : {}),
		};
	} catch {
		return opaque(tokens[index - 1]?.start);
	}
};
