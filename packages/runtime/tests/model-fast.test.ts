import { describe, expect, test } from "bun:test";
import { resolveFastMode } from "../src/model-fast";

describe("model fast mode resolution", () => {
	test("enables OpenAI priority service tier for supported models only", () => {
		expect(
			resolveFastMode({
				provider: "openai",
				model: "gpt-5.1",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "openai", serviceTier: "priority" });
		expect(
			resolveFastMode({
				provider: "openai",
				model: "gpt-5.4",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "openai", serviceTier: "priority" });
		expect(
			resolveFastMode({
				provider: "openai",
				model: "gpt-5.5",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "openai", serviceTier: "priority" });
		expect(
			resolveFastMode({
				provider: "openai",
				model: "gpt-5.3-codex",
				requested: true,
			}),
		).toEqual({ enabled: false });
		expect(
			resolveFastMode({
				provider: "openai",
				model: "gpt-5-nano",
				requested: true,
			}),
		).toEqual({ enabled: false });
	});

	test("enables Anthropic fast mode for supported models only", () => {
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-opus-4-6",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "anthropic", fastMode: true });
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				requested: true,
			}),
		).toEqual({ enabled: false });
	});

	test("keeps fast mode disabled when the flag is not requested", () => {
		expect(
			resolveFastMode({
				provider: "openai",
				model: "gpt-5.1",
				requested: false,
			}),
		).toEqual({ enabled: false });
	});
});
