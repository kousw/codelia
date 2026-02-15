const normalizeLanguage = (value: string): string => {
	const token = value.trim().toLowerCase();
	if (!token) return "";
	switch (token) {
		case "yml":
			return "yaml";
		case "mjs":
		case "cjs":
		case "node":
			return "javascript";
		case "mts":
		case "cts":
		case "ts-node":
		case "deno":
			return "typescript";
		case "py":
		case "python3":
			return "python";
		case "rb":
			return "ruby";
		case "zsh":
		case "sh":
			return "bash";
		case "ps1":
			return "powershell";
		default:
			return token;
	}
};

export const languageFromFilePath = (
	filePath: string | null | undefined,
): string | undefined => {
	if (!filePath) return undefined;
	const path = filePath.trim().replace(/^["']|["']$/g, "");
	if (!path || path === "/dev/null") return undefined;
	const normalizedPath = path.replace(/^a\//, "").replace(/^b\//, "");
	const lastSlash = Math.max(
		normalizedPath.lastIndexOf("/"),
		normalizedPath.lastIndexOf("\\"),
	);
	const basename =
		lastSlash >= 0 ? normalizedPath.slice(lastSlash + 1) : normalizedPath;
	if (!basename) return undefined;

	const dotIndex = basename.lastIndexOf(".");
	if (dotIndex > 0 && dotIndex < basename.length - 1) {
		return normalizeLanguage(basename.slice(dotIndex + 1));
	}

	if (basename === "Dockerfile") return "dockerfile";
	if (/^Makefile(\..+)?$/i.test(basename)) return "makefile";
	return undefined;
};

export const languageFromDiffHeaders = (
	diff: string | null | undefined,
): string | undefined => {
	if (!diff) return undefined;
	for (const line of diff.split("\n")) {
		if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
		const rawPath = line.slice(4).trim().split(/\s+/)[0] ?? "";
		const language = languageFromFilePath(rawPath);
		if (language) return language;
	}
	return undefined;
};

export const languageFromShebang = (
	content: string | null | undefined,
): string | undefined => {
	if (!content) return undefined;
	const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
	if (!firstLine.startsWith("#!")) return undefined;

	const body = firstLine.slice(2).trim();
	if (!body) return undefined;
	const parts = body.split(/\s+/).filter(Boolean);
	if (!parts.length) return undefined;

	let command = parts[0];
	if (command.endsWith("/env")) {
		let index = 1;
		if (parts[index] === "-S") index += 1;
		while (index < parts.length && parts[index].includes("=")) {
			index += 1;
		}
		command = parts[index] ?? "";
	}
	if (!command) return undefined;
	const last = command.split("/").pop() ?? command;
	const simplified = last.replace(/[0-9.]+$/g, "");
	const normalized = normalizeLanguage(simplified);
	return normalized || undefined;
};

type ResolveLanguageHintInput = {
	language?: string | null;
	filePath?: string | null;
	diff?: string | null;
	content?: string | null;
};

export const resolvePreviewLanguageHint = (
	input: ResolveLanguageHintInput,
): string | undefined => {
	const explicit = input.language ? normalizeLanguage(input.language) : "";
	if (explicit) return explicit;

	const shebang = languageFromShebang(input.content);
	if (shebang) return shebang;

	const fromDiff = languageFromDiffHeaders(input.diff);
	if (fromDiff) return fromDiff;

	return languageFromFilePath(input.filePath);
};

