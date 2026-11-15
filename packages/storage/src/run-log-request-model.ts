import type { LlmUsageRecord } from "@codelia/core";

const TOKENS = /["\\{}[\]:,]/g;
const MAX_KEY_BYTES = 256;
const MAX_MODEL_BYTES = 64 * 1024;

/** Select only top-level seq/model; nested request payloads are scanned, never retained. */
export class RunLogRequestModel {
	private depth = 0;
	private inString = false;
	private escapeAt = -2;
	private offset = 0;
	private complete = false;
	private key?: string;
	private inValue = false;
	private capture?: "key" | "value";
	private parts: Buffer[] = [];
	private bytes = 0;
	private readonly fields: Record<string, unknown> = {};

	push(data: Buffer): void {
		if (this.complete) {
			if (data.toString("utf8").trim())
				throw new Error("Extra request record data");
			return;
		}
		let captureStart = this.capture ? 0 : undefined;
		const append = (end: number) => {
			if (captureStart === undefined || end <= captureStart) return;
			this.bytes += end - captureStart;
			if (
				this.bytes > (this.capture === "key" ? MAX_KEY_BYTES : MAX_MODEL_BYTES)
			)
				throw new Error("Request accounting metadata is too large");
			this.parts.push(data.subarray(captureStart, end));
		};
		const finish = (end: number): unknown => {
			append(end);
			const value = JSON.parse(
				Buffer.concat(this.parts, this.bytes).toString("utf8"),
			);
			this.capture = undefined;
			this.parts = [];
			this.bytes = 0;
			captureStart = undefined;
			return value;
		};
		const finishValue = (end: number) => {
			if (this.capture === "value" && this.key !== undefined)
				this.fields[this.key] = finish(end);
			this.key = undefined;
			this.inValue = false;
		};
		const text = data.toString("latin1");
		const tokens = new RegExp(TOKENS);
		for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
			const index = match.index;
			const token = match[0];
			const absolute = this.offset + index;
			if (this.inString) {
				if (absolute === this.escapeAt + 1) {
					this.escapeAt = -2;
					continue;
				}
				if (token === "\\") {
					this.escapeAt = absolute;
					continue;
				}
				if (token !== '"') continue;
				this.inString = false;
				if (this.capture === "key") this.key = finish(index + 1) as string;
				continue;
			}
			if (token === '"') {
				this.inString = true;
				if (this.depth === 1 && !this.inValue && this.key === undefined) {
					this.capture = "key";
					captureStart = index;
				}
			} else if (token === "{" || token === "[") this.depth++;
			else if (token === "}" || token === "]") {
				if (this.depth === 1) finishValue(index);
				this.depth--;
				if (this.depth === 0) {
					this.complete = true;
					if (
						data
							.subarray(index + 1)
							.toString("utf8")
							.trim()
					)
						throw new Error("Extra request record data");
					break;
				}
			} else if (token === ":" && this.depth === 1 && !this.inValue) {
				this.inValue = true;
				if (this.key === "seq" || this.key === "model") {
					this.capture = "value";
					captureStart = index + 1;
				}
			} else if (token === "," && this.depth === 1) finishValue(index);
		}
		append(data.length);
		this.offset += data.length;
	}

	finish(): { seq: number; model?: LlmUsageRecord["model"] } | undefined {
		if (!this.complete || this.inString || this.capture)
			throw new Error("Incomplete request accounting metadata");
		const { seq, model } = this.fields;
		if (seq === undefined && model === undefined) return undefined;
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)
			throw new Error("Invalid request accounting sequence");
		if (model === undefined || model === null) return { seq };
		if (typeof model !== "object" || Array.isArray(model))
			throw new Error("Invalid request accounting model");
		const { provider, name } = model as Record<string, unknown>;
		if (
			(provider !== undefined && typeof provider !== "string") ||
			(name !== undefined && typeof name !== "string")
		)
			throw new Error("Invalid request accounting identity");
		return { seq, model: { provider, name } };
	}
}
