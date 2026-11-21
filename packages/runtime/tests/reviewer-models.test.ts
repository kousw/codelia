import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import { SUPPORTED_PROVIDERS } from "../src/auth/resolver";
import { AuthStore } from "../src/auth/store";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { LocalAutoReview } from "../src/permissions/local-reviewer";
import {
	createPublicApprovalReviewer,
	localReviewModels,
	type RegisteredReviewModel,
	selectFollowingReviewModel,
	selectLocalReviewModel,
} from "../src/permissions/reviewer-models";
import { RuntimeState } from "../src/runtime-state";

const alternate: RegisteredReviewModel = {
	provider: "fixture-reviewer",
	providerName: "Fixture reviewer",
	model: "fixture-model",
	endpoint: "https://reviewer.example.invalid/review",
	billing: "Fixture billing",
	revision: 1,
	createAdapter() {
		throw new Error("Create only when explicitly authorized");
	},
};

test("SDK hosts explicitly opt in to broader shell review", () => {
	const options = { apiKey: "fixture", buildEvidence: async () => null };
	expect(createPublicApprovalReviewer(options).categories).toEqual([
		"local_test",
		"dependency_read",
	]);
	expect(
		createPublicApprovalReviewer({ ...options, categories: ["local_shell"] })
			.categories,
	).toEqual(["local_shell"]);
});

test("review selection accepts only registered pairs and elides single-model choices", () => {
	const registry = [
		...localReviewModels,
		alternate,
		{ ...alternate, model: "fixture-model-2" },
	];
	expect(localReviewModels.map(({ provider }) => provider).sort()).toEqual(
		[...SUPPORTED_PROVIDERS].sort(),
	);
	for (const provider of SUPPORTED_PROVIDERS)
		expect(selectFollowingReviewModel(registry, provider)).toBe(
			selectLocalReviewModel(registry, provider),
		);
	expect(selectLocalReviewModel(registry)?.model).toBe("gpt-6-luna");
	expect(selectLocalReviewModel(registry, "openai")?.model).toBe("gpt-6-luna");
	expect(selectLocalReviewModel(registry, "google")).toMatchObject({
		model: "gemini-4-hydrogen",
		experimental: true,
	});
	expect(selectLocalReviewModel(registry, alternate.provider)).toBeUndefined();
	expect(
		selectLocalReviewModel(registry, alternate.provider, alternate.model),
	).toBe(alternate);
	expect(
		selectLocalReviewModel(registry, alternate.provider, "gpt-6-luna"),
	).toBeUndefined();
	expect(
		selectLocalReviewModel(registry, "openai", "gpt-6-astra"),
	).toBeUndefined();
	expect(
		selectLocalReviewModel(registry, undefined, "gpt-6-luna"),
	).toBeUndefined();
});

test.skipIf(typeof process.geteuid !== "function")(
	"switching a reviewer invalidates pending decisions and uses the configured provider key",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-review-models-")),
		);
		const workspace = path.join(root, "workspace");
		const originalFetch = globalThis.fetch;
		const layout = process.env.CODELIA_LAYOUT;
		const xdg = process.env.XDG_CONFIG_HOME;
		const oldCache = process.env.XDG_CACHE_HOME;
		const oldState = process.env.XDG_STATE_HOME;
		const state = new RuntimeState();
		let finishOpenAi: (() => void) | undefined;
		let openAiSends = 0;
		let fixtureSends = 0;
		let launches = 0;
		let seen = false;
		const gates = new LocalAutoReview(state, [
			...localReviewModels,
			{
				...alternate,
				createAdapter(options) {
					expect(options.apiKey).toBe("fixture-alternate-review-key");
					return {
						categories: ["local_test"],
						buildEvidence: options.buildEvidence,

						review: async (packet) => {
							fixtureSends++;
							return fixtureSends === 1
								? null
								: {
										request_id: JSON.parse(packet).request_id,
										decision: "allow_once",
										reason: "fixture",
									};
						},
					};
				},
			},
		]);
		try {
			process.env.CODELIA_LAYOUT = "xdg";
			process.env.XDG_CONFIG_HOME = path.join(root, "config");
			process.env.XDG_CACHE_HOME = path.join(root, "cache");
			process.env.XDG_STATE_HOME = path.join(root, "state");
			const dir = resolveStoragePaths().configDir;
			mkdirSync(dir, { recursive: true });
			mkdirSync(workspace);
			await new AuthStore().save({
				version: 1,
				providers: {
					openai: { method: "api_key", api_key: "fixture-openai-review-key" },
					[alternate.provider]: {
						method: "api_key",
						api_key: "fixture-alternate-review-key",
					},
				},
			});
			const base = {
				version: 3,
				enabled: true,
				categories: ["local_shell"],
				mode: "pin",
			};
			const save = (changes: Record<string, unknown>) =>
				writeFileSync(
					path.join(dir, "auto-review.json"),
					JSON.stringify({ ...base, ...changes }),
					{ mode: 0o600 },
				);
			const dispatcher = new ApprovalDispatcher({
				review: gates.adapter,
				confirmation: {
					confirm: async ({ requestId }) => ({
						requestId,
						choice: "deny_continue",
					}),
				},
			});
			const owner = state.nextSessionId();
			state.sessionId = owner;
			state.runtimeSandboxRoot = workspace;
			state.setUiCapabilities({ supports_structured_approval: true });
			state.beginRun("fixture", null, "Run the local fixture tests.");
			const propose = (beforeLaunch?: () => void) =>
				dispatcher.dispatch({
					request: {
						id: crypto.randomUUID(),
						owner,
						subject: "shell",
						registration: "builtin.shell/1",
						origin: "parent_agent",
						authorityVersion: "1",
						intentVersion: state.approvalContext(),
						connectionGeneration: String(state.approvalConnectionGeneration),
						runId: "fixture",
						input: JSON.stringify({
							invocation: {
								kind: "source",
								dialect: "bash",
								executable: "/bin/bash",
								options: [],
								source: "bun test",
							},
							protection: {
								profile: "development",
								root: workspace,
								cwd: workspace,
								stdin: "closed",
								writeRoots: [workspace],
							},
							analysis: {
								compound: false,
								opaque: false,
								operations: [{ argv: ["bun", "test"] }],
							},
						}),
					},
					evaluate: () => ({
						valid: true,
						owned: true,
						enforceable: true,
						registered: true,
						profile: "development",
						requested: [],
						granted: [],
						ceiling: [],
						reviewCategory: "local_test",
					}),
					stillCurrent: () => true,
					preview: () => "bun test",
					deferConsumption: beforeLaunch !== undefined,
					execute: (consume) => {
						if (beforeLaunch) {
							beforeLaunch();
							consume();
						}
						return ++launches;
					},
				});
			globalThis.fetch = Object.assign(
				async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
					expect(String(url)).toBe("https://api.openai.com/v1/responses");
					expect(new Headers(init?.headers).get("authorization")).toBe(
						"Bearer fixture-openai-review-key",
					);
					const body = JSON.parse(String(init?.body));
					expect(body.model).toBe("gpt-6-luna");
					openAiSends++;
					return new Promise<Response>((resolve) => {
						finishOpenAi = () =>
							resolve(
								Response.json({
									status: "completed",
									output: [
										{
											type: "message",
											role: "assistant",
											content: [
												{
													type: "output_text",
													text: JSON.stringify({
														request_id: JSON.parse(body.input).request_id,
														decision: "allow_once",
														reason: "fixture",
													}),
												},
											],
										},
									],
								}),
							);
						seen = true;
					});
				},
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;
			save({ provider: "openai", model: alternate.model });
			expect(gates.startupStatus(workspace)).toEqual({
				auto_review: "unavailable",
				auto_review_confined_launch_enabled: false,
				auto_review_issue: "unregistered_review_model",
			});
			await expect(propose()).rejects.toThrow("user_denied");
			save({ endpoint: alternate.endpoint });
			expect(gates.startupStatus(workspace).auto_review).toBe("unavailable");
			await expect(propose()).rejects.toThrow("user_denied");

			save({});
			expect(gates.status(workspace)).toMatchObject({ state: "active", provider: "openai" });
			const waiting = propose().then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			const deadline = Date.now() + 1000;
			while (!seen && Date.now() < deadline) await Bun.sleep(5);
			expect(seen).toBe(true);
			save({ provider: alternate.provider });
			finishOpenAi?.();
			const settled = await waiting;
			expect("error" in settled && String(settled.error)).toContain(
				"user_denied",
			);
			expect([openAiSends, fixtureSends, launches]).toEqual([1, 0, 0]);
			expect(gates.status(workspace)).toMatchObject({ state: "active", provider: alternate.provider });
			await expect(propose()).rejects.toThrow("user_denied");
			expect(await propose()).toBe(1);
			await new AuthStore().update((auth) => {
				auth.providers[alternate.provider] = {
					method: "api_key",
					api_key: "rotated-alternate-key",
				};
			});
			expect(gates.status(workspace).state).toBe("active");
			await new AuthStore().update((auth) => {
				auth.providers[alternate.provider] = {
					method: "api_key",
					api_key: "fixture-alternate-review-key",
				};
			});
			expect(await propose()).toBe(2);
			expect([openAiSends, fixtureSends, launches]).toEqual([1, 3, 2]);
			await expect(propose(() => gates.revokeAuth(alternate.provider))).rejects.toThrow("approval_expired");
			expect(launches).toBe(2);
		} finally {
			finishOpenAi?.();
			globalThis.fetch = originalFetch;
			if (layout === undefined) delete process.env.CODELIA_LAYOUT;
			else process.env.CODELIA_LAYOUT = layout;
			if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = xdg;
			if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
			else process.env.XDG_CACHE_HOME = oldCache;
			if (oldState === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = oldState;
			rmSync(root, { recursive: true, force: true });
		}
	},
);
