import { createHash } from "node:crypto";
import type { LlmStatusEvent } from "@codelia/shared-types";

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const identifier = (value: unknown): string | undefined =>
	typeof value === "string" && /^[a-zA-Z0-9._/-]{1,128}$/.test(value)
		? value
		: undefined;
const stringList = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length <= 64 &&
	value.every((item) => typeof item === "string");
const headerValue = (headers: unknown, name: string): string | undefined => {
	const entries = record(headers);
	const value =
		entries &&
		Object.entries(entries).find(([key]) => key.toLowerCase() === name)?.[1];
	return typeof value === "string"
		? value
		: Array.isArray(value) && typeof value[0] === "string"
			? value[0]
			: undefined;
};

export const isCodexBackend = (baseURL: string): boolean => {
	try {
		const url = new URL(baseURL);
		return (
			url.origin === "https://chatgpt.com" &&
			url.pathname.replace(/\/$/, "") === "/backend-api/codex"
		);
	} catch {
		return false;
	}
};

/** Opaque routing data: only held in memory for one run, never in diagnostics. */
export class CodexTurnState {
	private owner?: string;
	private value?: string;
	private invalidated = false;

	bindAuth(headers: Headers): boolean {
		const authorization = headers.get("authorization") ?? "";
		let identity = authorization;
		// JWT claims are used only as a cache ownership hint, never to authorize
		// anything. Stable identity keeps routing intact on ordinary token refresh.
		try {
			const claims = record(
				JSON.parse(
					Buffer.from(
						authorization.replace(/^Bearer /i, "").split(".")[1],
						"base64url",
					).toString("utf8"),
				),
			);
			if (typeof claims?.sub === "string" && typeof claims.iss === "string") {
				const account = record(
					claims["https://api.openai.com/auth"],
				)?.chatgpt_account_id;
				identity = JSON.stringify([
					claims.iss,
					claims.sub,
					typeof claims.client_id === "string" ? claims.client_id : null,
					typeof account === "string" ? account : null,
				]);
			}
		} catch {
			/* Opaque credentials use their full hash instead. */
		}
		const owner = createHash("sha256")
			.update(identity)
			.update("\0")
			.update(headers.get("chatgpt-account-id") ?? "")
			.digest("hex");
		const changed = this.owner !== undefined && this.owner !== owner;
		if (changed) {
			this.value = undefined;
			this.invalidated = true;
		}
		this.owner = owner;
		return this.invalidated;
	}

	observe(value: unknown): void {
		if (
			this.value === undefined &&
			typeof value === "string" &&
			value.length > 0 &&
			value.length <= 8192 &&
			/^[!-~]+$/.test(value)
		)
			this.value = value;
	}

	requestHeaders(): Record<string, string> {
		return this.value ? { "x-codex-turn-state": this.value } : {};
	}
}

export type CodexMetadataSummary = {
	server_model?: string;
	model_verifications?: Array<"trusted_access_for_cyber">;
	moderation_metadata_present?: boolean;
	safety_buffering?: {
		active: boolean;
		use_case_count: number;
		reason_count: number;
		faster_model?: string;
	};
};

/** Allowlisted facts only. No opaque moderation/routing/unknown payload retention. */
export class CodexMetadataCollector {
	private readonly summary: CodexMetadataSummary = {};
	private outputStarted = false;
	private fallbackModel?: string;
	private verificationNotified = false;

	constructor(
		private readonly routing?: CodexTurnState,
		private readonly onStatus?: (event: LlmStatusEvent) => void,
	) {}

	beginAttempt(): void {
		this.clearBuffering();
		for (const key of Object.keys(this.summary))
			delete this.summary[key as keyof CodexMetadataSummary];
		this.outputStarted = false;
		this.fallbackModel = undefined;
	}

	observeHeaders(headers: Headers): void {
		this.routing?.observe(headers.get("x-codex-turn-state"));
		const model = identifier(
			headers.get("openai-model") ?? headers.get("x-openai-model"),
		);
		if (model) this.summary.server_model = model;
		this.fallbackModel = identifier(
			headers.get("x-codex-safety-buffering-faster-model"),
		);
	}

	observeEvent(event: unknown): void {
		const value = record(event);
		if (!value) return;
		const response = record(value.response);
		const model = identifier(
			headerValue(response?.headers, "openai-model") ??
				headerValue(response?.headers, "x-openai-model") ??
				headerValue(value.headers, "openai-model") ??
				headerValue(value.headers, "x-openai-model"),
		);
		if (model) this.summary.server_model = model;
		const metadata =
			value.type === "response.metadata" ? record(value.metadata) : undefined;
		if (value.type === "response.metadata")
			this.routing?.observe(headerValue(value.headers, "x-codex-turn-state"));
		const verifications = metadata?.openai_verification_recommendation;
		if (
			Array.isArray(verifications) &&
			verifications.includes("trusted_access_for_cyber") &&
			!this.summary.model_verifications
		) {
			this.summary.model_verifications = ["trusted_access_for_cyber"];
			if (!this.verificationNotified) {
				this.verificationNotified = true;
				this.emit({
					type: "llm.status",
					provider: "openai",
					kind: "verification",
					verification: "trusted_access_for_cyber",
				});
			}
		}
		if (
			metadata &&
			Object.hasOwn(metadata, "openai_chatgpt_moderation_metadata")
		)
			this.summary.moderation_metadata_present = true;
		const buffering = record(
			value.safety_buffering ??
				(metadata?.type === "safety_buffering" ? metadata : undefined),
		);
		if (
			buffering &&
			stringList(buffering.use_cases) &&
			stringList(buffering.reasons)
		) {
			const faster = Object.hasOwn(buffering, "retry_model")
				? identifier(buffering.retry_model)
				: this.fallbackModel;
			const wasActive = this.summary.safety_buffering?.active;
			this.summary.safety_buffering = {
				active: !this.outputStarted,
				use_case_count: buffering.use_cases.length,
				reason_count: buffering.reasons.length,
				...(faster ? { faster_model: faster } : {}),
			};
			if (!this.outputStarted && !wasActive)
				this.emit({
					type: "llm.status",
					provider: "openai",
					kind: "buffering",
					active: true,
					...(faster ? { faster_model: faster } : {}),
				});
		}
		if (
			(value.type === "response.output_text.delta" ||
				value.type === "response.refusal.delta") &&
			typeof value.delta === "string" &&
			value.delta.length > 0
		) {
			this.outputStarted = true;
			this.clearBuffering();
		}
		if (
			value.type === "response.completed" ||
			value.type === "response.incomplete" ||
			value.type === "response.done" ||
			value.type === "response.failed" ||
			value.type === "error"
		)
			this.clearBuffering();
	}

	finish(): void {
		this.clearBuffering();
	}

	snapshot(): CodexMetadataSummary | undefined {
		return Object.keys(this.summary).length
			? structuredClone(this.summary)
			: undefined;
	}

	private clearBuffering(): void {
		if (this.summary.safety_buffering?.active) {
			this.summary.safety_buffering.active = false;
			this.emit({
				type: "llm.status",
				provider: "openai",
				kind: "buffering",
				active: false,
			});
		}
	}
	private emit(event: LlmStatusEvent): void {
		try {
			this.onStatus?.(event);
		} catch {
			/* UI telemetry must not fail a model request. */
		}
	}
}
