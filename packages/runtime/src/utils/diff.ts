const normalizeLineEndings = (text: string): string =>
	text.replace(/\r\n/g, "\n");

const toLines = (text: string): string[] =>
	text === "" ? [] : text.split("\n");

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
