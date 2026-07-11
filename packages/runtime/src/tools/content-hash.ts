import crypto from "node:crypto";

export const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const hashUtf8Content = (content: string): string =>
	crypto.createHash("sha256").update(content).digest("hex");

export const appendReadMetadata = (output: string, content: string): string =>
	`${output}\n\n[read_metadata] content_sha256=${hashUtf8Content(content)}`;
