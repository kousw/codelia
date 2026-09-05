/** Redact known credentials and common credential-shaped output before retention. */
export const redactSubagentText = (
	text: string,
	secrets: string[] = [],
): string => {
	let result = text;
	for (const secret of secrets)
		if (secret.length >= 8) result = result.split(secret).join("[redacted]");
	return result
		.replace(
			/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|org-[a-zA-Z0-9]{8,})\b/g,
			"[redacted]",
		)
		.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(/([a-z]+:\/\/)[^\s/:]+:[^\s/@]+@/gi, "$1[redacted]@");
};
export const clipUtf8 = (text: string, maxBytes: number): string => {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
};

/** Redact string values before JSON encoding so escapes remain valid. */
export const redactSubagentJson = <T extends object>(
	value: T,
	secrets: string[] = [],
): T =>
	JSON.parse(
		JSON.stringify(value, (_key, entry) =>
			typeof entry === "string" ? redactSubagentText(entry, secrets) : entry,
		),
	);
