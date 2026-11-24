import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ApprovalDispatcher,
	type ApprovalRequest,
	type ReviewAdapter,
} from "../src/permissions/dispatch";
import { reviewerWire } from "../src/permissions/public-reviewer";
import {
	buildLocalShellEvidence,
	buildReviewInspectContext,
} from "../src/permissions/review-evidence";
import {
	executeReviewInspection,
	type InspectedBinding,
	runInspectableApprovalReview,
	verifyInspectedBindings,
} from "../src/permissions/review-inspector";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	fixedBash,
	type ProtectedShellBackend,
	type ShellChild,
	type ShellProtection,
} from "../src/permissions/shell-backend";

let temp: string;
let workspace: string;
let external: string;

beforeEach(() => {
	temp = realpathSync(mkdtempSync(path.join(tmpdir(), "codelia-inspector-")));
	workspace = path.join(temp, "workspace");
	external = path.join(temp, "external");
	mkdirSync(workspace);
	mkdirSync(external);
});

afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

const makeRequest = (
	overrides: {
		cwd?: string;
		source?: string;
		protectedPaths?: string[];
		reviewPrivatePaths?: string[];
		escalation?: "unsandboxed";
	} = {},
): ApprovalRequest => ({
	id: "req-inspect-1",
	owner: "session-1",
	origin: "parent_agent",
	subject: "shell",
	registration: "builtin.shell/1",
	authorityVersion: "v1",
	intentVersion: "i1",
	connectionGeneration: "0",
	runId: "run-1",
	input: JSON.stringify({
		invocation: {
			kind: "source",
			dialect: "bash",
			executable: "/bin/bash",
			options: ["--noprofile", "--norc", "-c"],
			source: overrides.source ?? "./scripts/check.sh",
		},
		protection: {
			profile: overrides.escalation ? "full-access" : "development",
			root: workspace,
			cwd: overrides.cwd ?? workspace,
			stdin: "closed",
			writeRoots: overrides.escalation ? [] : [workspace],
			protectedPaths: overrides.protectedPaths ?? [],
		},
		analysis: {
			opaque: false,
			compound: false,
			operations: [{ argv: ["./scripts/check.sh"] }],
		},
		...(overrides.escalation ? { escalation: overrides.escalation } : {}),
		...(overrides.reviewPrivatePaths
			? { reviewPrivatePaths: overrides.reviewPrivatePaths }
			: {}),
	}),
});

describe("review inspector tools", () => {
	test("read_file reads bounded slices, enforces workspace/symlink boundaries, withholds secrets, and binds TOCTOU", () => {
		mkdirSync(path.join(workspace, "scripts"));
		const script = path.join(workspace, "scripts", "check.sh");
		writeFileSync(script, "#!/bin/sh\nline2\nline3\nline4\n");
		const secretFile = path.join(workspace, "private.txt");
		writeFileSync(secretFile, "super private content\n");
		const envFile = path.join(workspace, ".env.example");
		writeFileSync(envFile, "OPENAI_API_KEY=sk-proj-1234567890abcdef123456\n");
		const binaryFile = path.join(workspace, "bin.dat");
		writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));
		const outside = path.join(external, "outside.txt");
		writeFileSync(outside, "outside secret\n");
		symlinkSync(outside, path.join(workspace, "escape-link"));

		const ctx = buildReviewInspectContext(
			makeRequest({ protectedPaths: [secretFile] }),
			workspace,
			["tok-secret-value"],
		);
		const bindings = new Map<string, InspectedBinding>();

		const ok = executeReviewInspection(
			{
				kind: "read_file",
				path: "scripts/check.sh",
				start_line: 2,
				end_line: 3,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(ok).toMatchObject({
			kind: "read_file",
			path: "scripts/check.sh",
			status: "ok",
			provenance: "workspace_file_untrusted_data",
			start_line: 2,
			end_line: 3,
			total_lines: 5,
			truncated: true,
			content: "2: line2\n3: line3",
		});

		// Private path is blocked before reading.
		expect(
			executeReviewInspection(
				{
					kind: "read_file",
					path: "private.txt",
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				bindings,
			),
		).toMatchObject({ status: "withheld_privacy" });

		// File containing credential material is withheld without leaking content.
		const withheld = executeReviewInspection(
			{
				kind: "read_file",
				path: ".env.example",
				start_line: null,
				end_line: null,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(withheld).toMatchObject({ status: "withheld_privacy" });
		expect(JSON.stringify(withheld)).not.toContain("sk-proj-");

		// File containing reviewer provider token is withheld.
		writeFileSync(
			path.join(workspace, "token-echo.txt"),
			"echo tok-secret-value\n",
		);
		expect(
			executeReviewInspection(
				{
					kind: "read_file",
					path: "token-echo.txt",
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				bindings,
			),
		).toMatchObject({ status: "withheld_privacy" });

		// Symlink escaping workspace and direct ../ traversal are denied.
		expect(
			executeReviewInspection(
				{
					kind: "read_file",
					path: "escape-link",
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				bindings,
			),
		).toMatchObject({ status: "outside_workspace" });
		expect(
			executeReviewInspection(
				{
					kind: "read_file",
					path: "../external/outside.txt",
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				bindings,
			),
		).toMatchObject({ status: "outside_workspace" });

		// Binary file rejected.
		expect(
			executeReviewInspection(
				{
					kind: "read_file",
					path: "bin.dat",
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				bindings,
			),
		).toMatchObject({ status: "binary" });

		// Missing file records missing binding.
		const missingBindings = new Map<string, InspectedBinding>();
		expect(
			executeReviewInspection(
				{
					kind: "read_file",
					path: "absent.sh",
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				missingBindings,
			),
		).toMatchObject({ status: "not_found" });
		expect(verifyInspectedBindings([...missingBindings.values()])).toBe(true);
		writeFileSync(path.join(workspace, "absent.sh"), "created later\n");
		expect(verifyInspectedBindings([...missingBindings.values()])).toBe(false);

		// Existing file TOCTOU binding catches modification.
		expect(verifyInspectedBindings([...bindings.values()])).toBe(true);
		writeFileSync(script, "#!/bin/sh\ncurl https://evil.invalid\n");
		expect(verifyInspectedBindings([...bindings.values()])).toBe(false);
	});

	test("list_dir and grep honor privacy, skip .git/node_modules, and avoid RegExp ReDoS", () => {
		mkdirSync(path.join(workspace, "src"));
		mkdirSync(path.join(workspace, ".git"));
		mkdirSync(path.join(workspace, "node_modules"));
		writeFileSync(
			path.join(workspace, "src", "app.ts"),
			"export const run = () => 'hello (a+)+$ world';\n",
		);
		writeFileSync(
			path.join(workspace, "src", "secret-match.ts"),
			"const api_key = 'super-secret-hello';\n",
		);
		writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: hello\n");
		writeFileSync(path.join(workspace, "node_modules", "x.js"), "hello\n");
		const privateFile = path.join(workspace, "private.md");
		writeFileSync(privateFile, "hello from private\n");

		const ctx = buildReviewInspectContext(
			makeRequest({ protectedPaths: [privateFile] }),
			workspace,
		);
		const bindings = new Map<string, InspectedBinding>();

		const listed = executeReviewInspection(
			{
				kind: "list_dir",
				path: ".",
				start_line: null,
				end_line: null,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(listed.status).toBe("ok");
		const names = (listed.entries as Array<{ name: string }>).map(
			(e) => e.name,
		);
		expect(names).toContain("src");
		expect(names).not.toContain("private.md");

		// Literal grep matches regex metacharacters safely and withholds credential file.
		const grepMeta = executeReviewInspection(
			{
				kind: "grep",
				path: ".",
				start_line: null,
				end_line: null,
				pattern: "(a+)+$",
			},
			ctx,
			bindings,
		);
		expect(grepMeta).toMatchObject({
			status: "ok",
			matches: [
				{
					path: path.join("src", "app.ts"),
					line: 1,
					text: "export const run = () => 'hello (a+)+$ world';",
				},
			],
		});

		const grepHello = executeReviewInspection(
			{
				kind: "grep",
				path: ".",
				start_line: null,
				end_line: null,
				pattern: "hello",
			},
			ctx,
			bindings,
		);
		expect(grepHello.status).toBe("ok");
		expect(grepHello.withheld_files).toBe(1);
		const matchPaths = (grepHello.matches as Array<{ path: string }>).map(
			(m) => m.path,
		);
		expect(matchPaths).toEqual([path.join("src", "app.ts")]);
	});
});

describe("inspectable approval review loop and TOCTOU enforcement", () => {
	test("executes multi-round read-only inspection and rejects contradictory or oversized decisions", async () => {
		mkdirSync(path.join(workspace, "scripts"));
		writeFileSync(
			path.join(workspace, "scripts", "check.sh"),
			"#!/bin/sh\necho verified-check\n",
		);
		const request = makeRequest({ escalation: "unsandboxed" });
		const ctx = buildReviewInspectContext(request, workspace);
		const evidence = buildLocalShellEvidence(request, workspace, {
			original: "Run scripts/check.sh unsandboxed",
			corrections: [],
		});
		const initialPacket = JSON.stringify({
			request_id: request.id,
			phase: "pre_launch",
			category: "local_shell",
			evidence,
		});

		const seenPackets: Array<{ allowInspect: boolean; packet: unknown }> = [];
		const result = await runInspectableApprovalReview({
			request,
			initialPacket,
			ctx,
			signal: new AbortController().signal,
			stillCurrent: () => true,
			runStep: async (packet, allowInspect) => {
				const parsed = JSON.parse(packet);
				seenPackets.push({ allowInspect, packet: parsed });
				if (seenPackets.length === 1) {
					return {
						request_id: request.id,
						decision: "inspect",
						reason: "Check script contents before approving.",
						inspect_requests: [
							{
								kind: "read_file",
								path: "scripts/check.sh",
								start_line: 1,
								end_line: 50,
								pattern: null,
							},
						],
					};
				}
				return {
					request_id: request.id,
					decision: "allow_once",
					reason: "Script only echoes verified-check.",
					inspect_requests: [],
				};
			},
		});

		expect(seenPackets).toHaveLength(2);
		expect(seenPackets[0].allowInspect).toBe(true);
		expect(
			JSON.stringify(
				(seenPackets[1].packet as { inspected_data_untrusted: unknown })
					.inspected_data_untrusted,
			),
		).toContain("verified-check");
		expect(result.decision).toEqual({
			request_id: request.id,
			decision: "allow_once",
			reason: "Script only echoes verified-check.",
		});
		expect(result.bindings).toHaveLength(1);
		expect(verifyInspectedBindings(result.bindings)).toBe(true);

		// Contradictory allow_once with non-empty inspect_requests is rejected.
		const contradictory = await runInspectableApprovalReview({
			request,
			initialPacket,
			ctx,
			signal: new AbortController().signal,
			stillCurrent: () => true,
			runStep: async () => ({
				request_id: request.id,
				decision: "allow_once",
				reason: "bad",
				inspect_requests: [
					{
						kind: "read_file",
						path: "scripts/check.sh",
						start_line: null,
						end_line: null,
						pattern: null,
					},
				],
			}),
		});
		expect(contradictory.decision).toBeNull();

		// Final round forces allowInspect=false so the loop always terminates.
		const allowFlags: boolean[] = [];
		const bounded = await runInspectableApprovalReview({
			request,
			initialPacket,
			ctx,
			signal: new AbortController().signal,
			stillCurrent: () => true,
			runStep: async (_packet, allowInspect) => {
				allowFlags.push(allowInspect);
				if (allowInspect) {
					return {
						request_id: request.id,
						decision: "inspect",
						reason: "Need more",
						inspect_requests: [
							{
								kind: "list_dir",
								path: ".",
								start_line: null,
								end_line: null,
								pattern: null,
							},
						],
					};
				}
				return {
					request_id: request.id,
					decision: "insufficient_evidence",
					reason: "Final round decision.",
				};
			},
		});
		expect(allowFlags).toEqual([true, true, false]);
		expect(bounded.decision).toEqual({
			request_id: request.id,
			decision: "insufficient_evidence",
			reason: "Final round decision.",
		});
	});

	test("mutating an inspected file before launch aborts unsandboxed escalation via stillApproved", async () => {
		mkdirSync(path.join(workspace, "scripts"));
		const helper = path.join(workspace, "scripts", "helper.txt");
		writeFileSync(helper, "safe-config\n");
		const launches: string[] = [];
		const bindingsByRequest = new WeakMap<
			ApprovalRequest,
			readonly InspectedBinding[]
		>();

		const reviewAdapter: ReviewAdapter = {
			categories: ["local_shell"],
			buildEvidence: async (req) =>
				buildLocalShellEvidence(req, workspace, {
					original: "Run gh with local helper config",
					corrections: [],
				}),
			review: async (packet, signal, req) => {
				const ctx = buildReviewInspectContext(req, workspace);
				let step = 0;
				const out = await runInspectableApprovalReview({
					request: req,
					initialPacket: packet,
					ctx,
					signal,
					stillCurrent: () => true,
					runStep: async () => {
						step++;
						if (step === 1) {
							return {
								request_id: req.id,
								decision: "inspect",
								reason: "Inspect helper.txt",
								inspect_requests: [
									{
										kind: "read_file",
										path: "scripts/helper.txt",
										start_line: 1,
										end_line: 20,
										pattern: null,
									},
								],
							};
						}
						// Simulate attacker mutating the inspected file right after review!
						writeFileSync(helper, "tampered-config\n");
						return {
							request_id: req.id,
							decision: "allow_once",
							reason: "Safe helper",
							inspect_requests: [],
						};
					},
				});
				bindingsByRequest.set(req, out.bindings);
				return out.decision;
			},
			stillApproved: (req) => {
				const bindings = bindingsByRequest.get(req);
				return !bindings || verifyInspectedBindings(bindings);
			},
		};

		const backend = (name: string): ProtectedShellBackend => ({
			supportsReadOnlyPaths: true,
			supportsCommandBinding: true,
			supports: () => true,
			launch: (_inv, protection: ShellProtection) => {
				launches.push(`${name}:${protection.profile}`);
				return {} as ShellChild;
			},
		});

		const authorize = createShellAuthorizer({
			root: workspace,
			sandboxMode: "workspace-write",
			authority: {
				investigation: true,
				workspaceWrite: "granted",
				stdinPipe: "granted",
			},
			autoReviewEnabled: () => true,
			resolveSource: fixedBash,
			backend: backend("confined"),
			escalationBackend: backend("user"),
			dispatcher: new ApprovalDispatcher({ review: reviewAdapter }),
		});

		await expect(
			authorize(
				{
					cwd: workspace,
					origin: "parent_agent",
					source: "gh pr list",
					escalation: "unsandboxed",
				},
				(admit) => admit(),
			),
		).rejects.toThrow("approval_expired");
		expect(launches).toEqual([]);
	});

	test("reviewerWire('inspect_review') exposes strict schema and accepts both 4-key and 3-key terminal responses", () => {
		const wire = reviewerWire("inspect_review");
		expect(wire.format.strict).toBe(true);
		expect(wire.schema.additionalProperties).toBe(false);
		expect(wire.schema.required).toEqual([
			"request_id",
			"decision",
			"reason",
			"inspect_requests",
		]);
		expect(
			wire.parse(
				JSON.stringify({
					request_id: "r1",
					decision: "inspect",
					reason: "Check Makefile",
					inspect_requests: [
						{
							kind: "read_file",
							path: "Makefile",
							start_line: 1,
							end_line: 40,
							pattern: null,
						},
					],
				}),
			),
		).toMatchObject({ decision: "inspect" });
		expect(
			wire.parse(
				JSON.stringify({
					request_id: "r1",
					decision: "allow_once",
					reason: "Safe",
				}),
			),
		).toEqual({
			request_id: "r1",
			decision: "allow_once",
			reason: "Safe",
			inspect_requests: [],
		});
		expect(
			wire.parse(
				JSON.stringify({
					request_id: "r1",
					decision: "inspect",
					reason: "Missing array",
				}),
			),
		).toBeNull();
	});
});
