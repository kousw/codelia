import crypto from "node:crypto";
import { z } from "zod";

export const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const expectedContentHashSchema = z
	.string()
	.regex(
		CONTENT_SHA256_PATTERN,
		"expected_hash must be a lowercase 64-character SHA-256 hash",
	)
	.optional()
	.describe(
		"Current full-content SHA-256 guard from read/read_line metadata. Omit when unavailable.",
	);

export const hashUtf8Content = (content: string): string =>
	crypto.createHash("sha256").update(content).digest("hex");

export const assertExpectedContentHash = (input: {
	expectedHash?: string;
	fileExists: boolean;
	content: string;
	filePath: string;
}): void => {
	if (!input.expectedHash) return;
	if (!input.fileExists) {
		throw new Error(
			`Expected hash provided but file not found: ${input.filePath}`,
		);
	}
	if (hashUtf8Content(input.content) !== input.expectedHash) {
		throw new Error(
			`Hash mismatch for ${input.filePath}. The file changed since it was read; read it again and retry with the new content_sha256.`,
		);
	}
};

export const appendReadMetadata = (output: string, content: string): string =>
	`${output}\n\n[read_metadata] content_sha256=${hashUtf8Content(content)}`;
