import { expect, test } from "bun:test";
import type { LlmStatusEvent } from "@codelia/shared-types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import {
	CodexMetadataCollector,
	CodexTurnState,
} from "../src/llm/openai/codex-metadata";
import { getResponseStreamEventDebugPayload } from "../src/llm/openai/response-utils";

const event = {
	type: "response.metadata",
	headers: {
		"X-Codex-Turn-State": ["opaque-routing"],
		"OpenAI-Model": "gpt-6.1-sol",
	},
	metadata: {
		type: "safety_buffering",
		use_cases: ["cyber"],
		reasons: ["policy-check"],
		openai_verification_recommendation: ["unknown", "trusted_access_for_cyber"],
		openai_chatgpt_moderation_metadata: { secret: "opaque-moderation-content" },
		unknown: "never-persist-this",
	},
};

test("known metadata produces bounded facts and deduplicated early status without opaque payloads", () => {
	const statuses: LlmStatusEvent[] = [];
	const routing = new CodexTurnState();
	const collector = new CodexMetadataCollector(routing, (status) =>
		statuses.push(status),
	);
	collector.observeHeaders(
		new Headers({ "x-codex-safety-buffering-faster-model": "faster-model" }),
	);
	collector.observeEvent(event);
	collector.observeEvent(event);
	expect(statuses).toEqual([
		{
			type: "llm.status",
			provider: "openai",
			kind: "verification",
			verification: "trusted_access_for_cyber",
		},
		{
			type: "llm.status",
			provider: "openai",
			kind: "buffering",
			active: true,
			faster_model: "faster-model",
		},
	]);
	expect(routing.requestHeaders()).toEqual({
		"x-codex-turn-state": "opaque-routing",
	});
	collector.observeEvent({ type: "response.output_text.delta", delta: "hi" });
	collector.observeEvent(event); // Late metadata must not re-open buffering UI.
	collector.finish();
	expect(statuses.at(-1)).toMatchObject({ kind: "buffering", active: false });
	expect(statuses).toHaveLength(3);
	expect(collector.snapshot()).toEqual({
		server_model: "gpt-6.1-sol",
		model_verifications: ["trusted_access_for_cyber"],
		moderation_metadata_present: true,
		safety_buffering: {
			active: false,
			use_case_count: 1,
			reason_count: 1,
			faster_model: "faster-model",
		},
	});
	const diagnostic = JSON.stringify(
		getResponseStreamEventDebugPayload(event as unknown as ResponseStreamEvent),
	);
	for (const opaque of [
		"opaque-routing",
		"opaque-moderation-content",
		"never-persist-this",
	])
		expect(diagnostic).not.toContain(opaque);
	expect(diagnostic).toContain("moderation_metadata_present");
});

test("malformed/unknown metadata is inert, and explicit null retry model disables header fallback", () => {
	const collector = new CodexMetadataCollector();
	for (const metadata of [
		null,
		[],
		{ type: "unknown", arbitrary: "opaque" },
		{ type: "safety_buffering", use_cases: [1], reasons: [] },
		{ openai_verification_recommendation: "trusted_access_for_cyber" },
	])
		collector.observeEvent({ type: "response.metadata", metadata });
	expect(collector.snapshot()).toBeUndefined();
	collector.observeHeaders(
		new Headers({ "x-codex-safety-buffering-faster-model": "faster-model" }),
	);
	collector.observeEvent({
		type: "response.created",
		safety_buffering: { use_cases: [], reasons: [], retry_model: null },
	});
	expect(collector.snapshot()?.safety_buffering).not.toHaveProperty(
		"faster_model",
	);
	collector.observeEvent({ type: "response.failed" });
	expect(collector.snapshot()?.safety_buffering?.active).toBe(false);
});

test("routing remains opaque, first-value sticky, and resets when bearer auth changes", () => {
	const routing = new CodexTurnState();
	routing.bindAuth(new Headers({ authorization: "Bearer owner-a" }));
	for (const value of ["bad\nheader", "x".repeat(8193), { token: "bad" }])
		routing.observe(value);
	expect(routing.requestHeaders()).toEqual({});
	routing.observe("state-a");
	routing.observe("state-b");
	expect(routing.requestHeaders()).toEqual({ "x-codex-turn-state": "state-a" });
	expect(
		routing.bindAuth(new Headers({ authorization: "Bearer owner-b" })),
	).toBe(true);
	expect(routing.requestHeaders()).toEqual({});
});

test("broken status subscribers cannot fail metadata parsing", () => {
	const collector = new CodexMetadataCollector(undefined, () => {
		throw new Error("UI down");
	});
	expect(() => collector.observeEvent(event)).not.toThrow();
	collector.finish();
	expect(collector.snapshot()?.moderation_metadata_present).toBe(true);
});

test("JWT expiry/token rotation for the same account retains turn routing", () => {
	const routing = new CodexTurnState();
	const token = (exp: number) =>
		`header.${Buffer.from(JSON.stringify({ sub: "fixture-user", iss: "https://auth.openai.com", exp, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture-signature`;
	routing.bindAuth(new Headers({ authorization: `Bearer ${token(1)}` }));
	routing.observe("sticky-state");
	expect(
		routing.bindAuth(new Headers({ authorization: `Bearer ${token(2)}` })),
	).toBe(false);
	expect(routing.requestHeaders()).toEqual({
		"x-codex-turn-state": "sticky-state",
	});
});

test("fallback attempts reset transient model/buffering facts while retaining turn routing and deduplicating notices", () => {
	const routing = new CodexTurnState();
	const statuses: LlmStatusEvent[] = [];
	const collector = new CodexMetadataCollector(routing, (status) =>
		statuses.push(status),
	);
	collector.observeEvent(event);
	collector.beginAttempt();
	expect(collector.snapshot()).toBeUndefined();
	expect(routing.requestHeaders()).toEqual({
		"x-codex-turn-state": "opaque-routing",
	});
	expect(statuses.at(-1)).toMatchObject({ kind: "buffering", active: false });
	collector.observeEvent(event);
	expect(
		statuses.filter((status) => status.kind === "verification"),
	).toHaveLength(1);
	collector.finish();
});
