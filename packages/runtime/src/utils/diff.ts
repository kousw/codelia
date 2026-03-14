const DEFAULT_DIFF_PREVIEW_LINES = 120;
const DEFAULT_DIFF_PREVIEW_BYTES = 16 * 1024;

const normalizeLineEndings = (text: string): string =>
	text.replace(/\r\n/g, "\n");

const toLines = (text: string): string[] =>
	text === "" ? [] : text.split("\n");

const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const truncateUtf8Prefix = (value: string, maxBytes: number): string => {
	if (maxBytes <= 0 || value.length === 0) return "";
	let bytes = 0;
	let out = "";
	for (const ch of value) {
		const next = utf8ByteLength(ch);
		if (bytes + next > maxBytes) break;
		out += ch;
		bytes += next;
	}
	return out;
};

const truncateUtf8Suffix = (value: string, maxBytes: number): string => {
	if (maxBytes <= 0 || value.length === 0) return "";
	let bytes = 0;
	const chars = Array.from(value);
	const out: string[] = [];
	for (let index = chars.length - 1; index >= 0; index -= 1) {
		const ch = chars[index];
		const next = utf8ByteLength(ch);
		if (bytes + next > maxBytes) break;
		out.push(ch);
		bytes += next;
	}
	out.reverse();
	return out.join("");
};

const excerptByLines = (value: string, maxLines: number): { text: string; truncated: boolean } => {
	const lines = value.split(/\r?\n/);
	if (lines.length <= maxLines) {
		return { text: value, truncated: false };
	}
	const headCount = Math.ceil(maxLines / 2);
	const tailCount = Math.floor(maxLines / 2);
	const omitted = lines.length - headCount - tailCount;
	return {
		text: [
			...lines.slice(0, headCount),
			`...[${omitted} lines omitted]...`,
			...lines.slice(lines.length - tailCount),
		].join("\n"),
		truncated: true,
	};
};

const excerptByBytes = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
	if (utf8ByteLength(value) <= maxBytes) {
		return { text: value, truncated: false };
	}
	const marker = "\n...[truncated by size]...\n";
	const markerBytes = utf8ByteLength(marker);
	if (maxBytes <= markerBytes + 2) {
		return {
			text: truncateUtf8Prefix(value, maxBytes),
			truncated: true,
		};
	}
	const budget = maxBytes - markerBytes;
	const headBytes = Math.floor(budget / 2);
	const tailBytes = budget - headBytes;
	return {
		text: `${truncateUtf8Prefix(value, headBytes)}${marker}${truncateUtf8Suffix(value, tailBytes)}`,
		truncated: true,
	};
};

export const summarizeDiff = (
	diff: string,
	options: { maxLines?: number; maxBytes?: number } = {},
): { preview: string; truncated: boolean } => {
	const lineExcerpt = excerptByLines(diff, options.maxLines ?? DEFAULT_DIFF_PREVIEW_LINES);
	const byteExcerpt = excerptByBytes(
		lineExcerpt.text,
		options.maxBytes ?? DEFAULT_DIFF_PREVIEW_BYTES,
	);
	return {
		preview: byteExcerpt.text,
		truncated: lineExcerpt.truncated || byteExcerpt.truncated,
	};
};

export const createUnifiedDiff = (
	filePath: string,
	before: string,
	after: string,
	context = 3,
): string => {
	const oldText = normalizeLineEndings(before);
	const newText = normalizeLineEndings(after);
	if (oldText === newText) return "";

	const oldLines = toLines(oldText);
	const newLines = toLines(newText);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] ===
			newLines[newLines.length - 1 - suffix]
	) {
		suffix++;
	}

	const oldChangeStart = prefix;
	const oldChangeEnd = oldLines.length - suffix;
	const newChangeStart = prefix;
	const newChangeEnd = newLines.length - suffix;

	const hunkOldStart = Math.max(0, oldChangeStart - context);
	const hunkOldEnd = Math.min(oldLines.length, oldChangeEnd + context);
	const hunkNewStart = Math.max(0, newChangeStart - context);
	const hunkNewEnd = Math.min(newLines.length, newChangeEnd + context);

	const hunkOldLen = hunkOldEnd - hunkOldStart;
	const hunkNewLen = hunkNewEnd - hunkNewStart;
	const oldStartLine = hunkOldLen === 0 ? 0 : hunkOldStart + 1;
	const newStartLine = hunkNewLen === 0 ? 0 : hunkNewStart + 1;

	const header = [
		`--- ${filePath}`,
		`+++ ${filePath}`,
		`@@ -${oldStartLine},${hunkOldLen} +${newStartLine},${hunkNewLen} @@`,
	];

	const lines: string[] = [];
	for (let i = hunkOldStart; i < oldChangeStart; i++) {
		lines.push(` ${oldLines[i]}`);
	}
	for (let i = oldChangeStart; i < oldChangeEnd; i++) {
		lines.push(`-${oldLines[i]}`);
	}
	for (let i = newChangeStart; i < newChangeEnd; i++) {
		lines.push(`+${newLines[i]}`);
	}
	for (let i = oldChangeEnd; i < hunkOldEnd; i++) {
		lines.push(` ${oldLines[i]}`);
	}

	return `${header.join("\n")}\n${lines.join("\n")}`;
};
