import { describe, expect, test } from "bun:test";
import { resolveFastMode } from "../src/model-fast";

describe("model fast mode resolution", () => {
	test("enables OpenAI priority service tier for supported models only", () => {
		for (const model of [
			"gpt-6.1-terra",
			"gpt-6.1-sol",
			"gpt-6-sol",
			"gpt-6-luna",
		]) {
			expect(
				resolveFastMode({ provider: "openai", model, requested: true }),
			).toEqual({
				enabled: true,
				provider: "openai",
				serviceTier: "priority",
			});
		}
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
				model: "claude-opus-5-5",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "anthropic", fastMode: true });
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-opus-5",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "anthropic", fastMode: true });
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-opus-4-8",
				requested: true,
			}),
		).toEqual({ enabled: true, provider: "anthropic", fastMode: true });
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-opus-4-7",
				requested: true,
			}),
		).toEqual({ enabled: false });
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-opus-4-6",
				requested: true,
			}),
		).toEqual({ enabled: false });
		expect(
			resolveFastMode({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				requested: true,
			}),
		).toEqual({ enabled: false });
	});

	test.each(["claude-sonnet-5-5", "claude-haiku-5-5"])(
		"does not enable Fast for %s",
		(model) => {
			expect(
				resolveFastMode({ provider: "anthropic", model, requested: true }),
			).toEqual({ enabled: false });
			expect(() =>
				resolveFastMode({
					provider: "anthropic",
					model,
					requested: "ultrafast",
				}),
			).toThrow("Ultrafast requires OpenAI");
		},
	);

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

describe("explicit Ultrafast selection", () => {
	test.each(["gpt-6-astra", "gpt-6.1-sol"])(
		"selects Ultrafast for %s without changing boolean fast",
		(model) => {
			expect(
				resolveFastMode({ provider: "openai", model, requested: "ultrafast" }),
			).toEqual({
				enabled: true,
				provider: "openai",
				serviceTier: "ultrafast",
			});
			expect(
				resolveFastMode({ provider: "openai", model, requested: true }),
			).toEqual({ enabled: true, provider: "openai", serviceTier: "priority" });
		},
	);
	test.each([
		["openai", "gpt-6.1-terra"],
		["openai", "gpt-6-sol"],
		["anthropic", "claude-opus-5-5"],
		["openrouter", "openai/gpt-6.1-sol"],
		["home", "gpt-6-astra"],
	])(
		"rejects Ultrafast on %s/%s instead of silently downgrading",
		(provider, model) => {
			expect(() =>
				resolveFastMode({ provider, model, requested: "ultrafast" }),
			).toThrow("Ultrafast requires OpenAI");
		},
	);
});
