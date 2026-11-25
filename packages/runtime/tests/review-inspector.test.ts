import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	linkSync,
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
		reviewedDirectory?: string;
		binPaths?: string[];
		source?: string;
		operations?: Array<{ argv: string[] }>;
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
			...(overrides.binPaths ? { binPaths: overrides.binPaths } : {}),
			writeRoots: overrides.escalation ? [] : [workspace],
			protectedPaths: overrides.protectedPaths ?? [],
		},
		analysis: {
			opaque: false,
			compound: false,
			operations: overrides.operations ?? [{ argv: ["./scripts/check.sh"] }],
		},
		...(overrides.reviewedDirectory
			? { reviewedDirectory: overrides.reviewedDirectory }
			: {}),
		...(overrides.escalation ? { escalation: overrides.escalation } : {}),
		...(overrides.reviewPrivatePaths
			? { reviewPrivatePaths: overrides.reviewPrivatePaths }
			: {}),
	}),
});

describe("review inspector tools", () => {
	test("read_file reads bounded slices, enforces workspace/symlink/hardlink boundaries, withholds secrets before clipping, and binds TOCTOU", async () => {
		mkdirSync(path.join(workspace, "scripts"));
		const script = path.join(workspace, "scripts", "check.sh");
		writeFileSync(script, "\uFEFF#!/bin/sh\nline2\nline3\nline4\n");
		const secretFile = path.join(workspace, "private.txt");
		writeFileSync(secretFile, "super private content\n");
		const hardLinkAlias = path.join(workspace, "hardlink-to-private.txt");
		linkSync(secretFile, hardLinkAlias);
		const envFile = path.join(workspace, ".env.example");
		writeFileSync(envFile, "OPENAI_API_KEY=sk-proj-1234567890abcdef123456\n");
		const clippedSecret = path.join(workspace, "clipped-secret.txt");
		writeFileSync(
			clippedSecret,
			`${"a".repeat(4089)} sk-proj-1234567890abcdef123456\n`,
		);
		const binaryFile = path.join(workspace, "bin.dat");
		writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x03]));
		const outside = path.join(external, "outside.txt");
		writeFileSync(outside, "outside secret\n");
		symlinkSync(outside, path.join(workspace, "escape-link"));
		symlinkSync(
			path.join(workspace, "does-not-exist"),
			path.join(workspace, "dangling-link"),
		);

		const ctx = buildReviewInspectContext(
			makeRequest({ protectedPaths: [secretFile] }),
			workspace,
			["tok-secret-value"],
		);
		const bindings = new Map<string, InspectedBinding>();

		// Leading UTF-8 BOM is stripped cleanly instead of withheld as control char.
		const ok = await executeReviewInspection(
			{
				kind: "read_file",
				path: "scripts/check.sh",
				start_line: 1,
				end_line: 3,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(ok.conflict).toBe(false);
		expect(ok.result).toMatchObject({
			kind: "read_file",
			path: "scripts/check.sh",
			status: "ok",
			provenance: "workspace_file_untrusted_data",
			start_line: 1,
			end_line: 3,
			total_lines: 5,
			truncated: true,
			content: "1: #!/bin/sh\n2: line2\n3: line3",
		});

		// Private path is blocked before reading and does not echo private path name.
		const privateRead = await executeReviewInspection(
			{
				kind: "read_file",
				path: "private.txt",
				start_line: null,
				end_line: null,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(privateRead.result).toMatchObject({
			status: "withheld_privacy",
			path: "[redacted]",
		});

		// Hard link aliasing a protected inode is withheld via isProtectedAlias.
		const hardLinkRead = await executeReviewInspection(
			{
				kind: "read_file",
				path: "hardlink-to-private.txt",
				start_line: null,
				end_line: null,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(hardLinkRead.result).toMatchObject({ status: "withheld_privacy" });
		expect(JSON.stringify(hardLinkRead.result)).not.toContain("super private");

		// File containing credential material (even past the 4 KiB clip boundary) is withheld before clipping.
		for (const file of [".env.example", "clipped-secret.txt"]) {
			const withheld = await executeReviewInspection(
				{
					kind: "read_file",
					path: file,
					start_line: null,
					end_line: null,
					pattern: null,
				},
				ctx,
				bindings,
			);
			expect(withheld.result).toMatchObject({ status: "withheld_privacy" });
			expect(JSON.stringify(withheld.result)).not.toContain("sk-proj-");
		}

		// File containing reviewer provider token is withheld.
		writeFileSync(
			path.join(workspace, "token-echo.txt"),
			"echo tok-secret-value\n",
		);
		expect(
			(
				await executeReviewInspection(
					{
						kind: "read_file",
						path: "token-echo.txt",
						start_line: null,
						end_line: null,
						pattern: null,
					},
					ctx,
					bindings,
				)
			).result,
		).toMatchObject({ status: "withheld_privacy" });

		// Symlink escaping workspace, direct ../ traversal, and dangling symlink are denied.
		expect(
			(
				await executeReviewInspection(
					{
						kind: "read_file",
						path: "escape-link",
						start_line: null,
						end_line: null,
						pattern: null,
					},
					ctx,
					bindings,
				)
			).result,
		).toMatchObject({ status: "outside_workspace" });
		expect(
			(
				await executeReviewInspection(
					{
						kind: "read_file",
						path: "../external/outside.txt",
						start_line: null,
						end_line: null,
						pattern: null,
					},
					ctx,
					bindings,
				)
			).result,
		).toMatchObject({ status: "outside_workspace" });
		const danglingBindings = new Map<string, InspectedBinding>();
		expect(
			(
				await executeReviewInspection(
					{
						kind: "read_file",
						path: "dangling-link",
						start_line: null,
						end_line: null,
						pattern: null,
					},
					ctx,
					danglingBindings,
				)
			).result,
		).toMatchObject({ status: "dangling_symlink" });
		// Dangling symlink does not poison bindings with a failing missing entry.
		expect(verifyInspectedBindings([...danglingBindings.values()])).toBe(true);

		// Binary file rejected.
		expect(
			(
				await executeReviewInspection(
					{
						kind: "read_file",
						path: "bin.dat",
						start_line: null,
						end_line: null,
						pattern: null,
					},
					ctx,
					bindings,
				)
			).result,
		).toMatchObject({ status: "binary" });

		// Missing file records missing binding.
		const missingBindings = new Map<string, InspectedBinding>();
		expect(
			(
				await executeReviewInspection(
					{
						kind: "read_file",
						path: "absent.sh",
						start_line: null,
						end_line: null,
						pattern: null,
					},
					ctx,
					missingBindings,
				)
			).result,
		).toMatchObject({ status: "not_found" });
		expect(verifyInspectedBindings([...missingBindings.values()])).toBe(true);
		writeFileSync(path.join(workspace, "absent.sh"), "created later\n");
		expect(verifyInspectedBindings([...missingBindings.values()])).toBe(false);

		// Existing file TOCTOU binding catches modification.
		expect(verifyInspectedBindings([...bindings.values()])).toBe(true);
		writeFileSync(script, "#!/bin/sh\ncurl https://evil.invalid\n");
		expect(verifyInspectedBindings([...bindings.values()])).toBe(false);
	});

	test("list_dir and grep honor privacy, bind directory entry digests and non-matching files, and avoid RegExp ReDoS", async () => {
		mkdirSync(path.join(workspace, "src"));
		mkdirSync(path.join(workspace, ".git"));
		mkdirSync(path.join(workspace, "node_modules"));
		writeFileSync(
			path.join(workspace, "src", "app.ts"),
			"export const run = () => 'hello (a+)+$ world';\n",
		);
		const cleanFile = path.join(workspace, "src", "clean.ts");
		writeFileSync(cleanFile, "export const safe = 1;\n");
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
		const listBindings = new Map<string, InspectedBinding>();

		const listed = await executeReviewInspection(
			{
				kind: "list_dir",
				path: ".",
				start_line: null,
				end_line: null,
				pattern: null,
			},
			ctx,
			listBindings,
		);
		expect(listed.result.status).toBe("ok");
		const names = (listed.result.entries as Array<{ name: string }>).map(
			(e) => e.name,
		);
		expect(names).toContain("src");
		expect(names).not.toContain("private.md");
		expect(verifyInspectedBindings([...listBindings.values()])).toBe(true);

		// Adding a file to a listed directory invalidates its entriesDigest binding.
		writeFileSync(path.join(workspace, "new-entry.txt"), "x\n");
		expect(verifyInspectedBindings([...listBindings.values()])).toBe(false);
		rmSync(path.join(workspace, "new-entry.txt"));

		// Literal grep matches regex metacharacters safely and binds non-matching files too.
		const grepBindings = new Map<string, InspectedBinding>();
		const grepMeta = await executeReviewInspection(
			{
				kind: "grep",
				path: ".",
				start_line: null,
				end_line: null,
				pattern: "(a+)+$",
			},
			ctx,
			grepBindings,
		);
		expect(grepMeta.result).toMatchObject({
			status: "ok",
			matches: [
				{
					path: path.join("src", "app.ts"),
					line: 1,
					text: "export const run = () => 'hello (a+)+$ world';",
				},
			],
		});
		expect(verifyInspectedBindings([...grepBindings.values()])).toBe(true);
		// Mutating a previously non-matching file invalidates grep bindings!
		writeFileSync(cleanFile, "export const evil = '(a+)+$';\n");
		expect(verifyInspectedBindings([...grepBindings.values()])).toBe(false);

		const grepHello = await executeReviewInspection(
			{
				kind: "grep",
				path: ".",
				start_line: null,
				end_line: null,
				pattern: "hello",
			},
			ctx,
			new Map<string, InspectedBinding>(),
		);
		expect(grepHello.result.status).toBe("ok");
		expect(grepHello.result.withheld_files).toBe(1);
		const matchPaths = (
			grepHello.result.matches as Array<{ path: string }>
		).map((m) => m.path);
		expect(matchPaths).toEqual([path.join("src", "app.ts")]);
	});
});

describe("inspectable approval review loop and TOCTOU enforcement", () => {
	test("refuses blind allow_once on an uninspected workspace-local executable, and allows once fully read", async () => {
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

		// Round 0 blind allow_once without reading scripts/check.sh is downgraded to insufficient_evidence.
		const blind = await runInspectableApprovalReview({
			request,
			initialPacket,
			ctx,
			signal: new AbortController().signal,
			stillCurrent: () => true,
			runStep: async () => ({
				request_id: request.id,
				decision: "allow_once",
				reason: "Looks okay without reading.",
				inspect_requests: [],
			}),
		});
		expect(blind.decision).toMatchObject({
			request_id: request.id,
			decision: "insufficient_evidence",
		});

		// Multi-round inspection fully reads scripts/check.sh, then allow_once succeeds.
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

		// Steer / revision invalidation mid-inspection immediately aborts the loop.
		let current = true;
		let steerSteps = 0;
		const steered = await runInspectableApprovalReview({
			request,
			initialPacket,
			ctx,
			signal: new AbortController().signal,
			stillCurrent: () => current,
			runStep: async () => {
				steerSteps++;
				current = false;
				return {
					request_id: request.id,
					decision: "inspect",
					reason: "Inspect",
					inspect_requests: [
						{
							kind: "read_file",
							path: "scripts/check.sh",
							start_line: 1,
							end_line: 20,
							pattern: null,
						},
					],
				};
			},
		});
		expect(steerSteps).toBe(1);
		expect(steered.decision).toBeNull();
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

	test("reviewerWire('inspect_review') exposes strict schema without numeric bounds and accepts both 4-key and 3-key terminal responses", () => {
		const wire = reviewerWire("inspect_review");
		expect(wire.format.strict).toBe(true);
		expect(wire.schema.additionalProperties).toBe(false);
		expect(wire.schema.required).toEqual([
			"request_id",
			"decision",
			"reason",
			"inspect_requests",
		]);
		// Ensure no numeric minimum/maximum constraints leak into structured output schemas.
		const serializedSchema = JSON.stringify(wire.format.schema);
		expect(serializedSchema).not.toContain('"minimum"');
		expect(serializedSchema).not.toContain('"maximum"');
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

	test("withholds partial read_file and grep excerpts from a file with a PEM private key header", async () => {
		const pemFile = path.join(workspace, "key.pem");
		writeFileSync(
			pemFile,
			[
				"-----BEGIN RSA PRIVATE KEY-----",
				"MIIEowIBAAKCAQEAmarkerbodyline1",
				"MIIEowIBAAKCAQEAmarkerbodyline2",
				"-----END RSA PRIVATE KEY-----",
			].join("\n"),
		);
		const ctx = buildReviewInspectContext(
			makeRequest({ source: "ls", operations: [{ argv: ["ls"] }] }),
			workspace,
		);
		const bindings = new Map<string, InspectedBinding>();
		const readRes = await executeReviewInspection(
			{
				kind: "read_file",
				path: "key.pem",
				start_line: 2,
				end_line: 3,
				pattern: null,
			},
			ctx,
			bindings,
		);
		expect(readRes.result).toMatchObject({ status: "withheld_privacy" });
		const grepRes = await executeReviewInspection(
			{
				kind: "grep",
				path: "key.pem",
				start_line: null,
				end_line: null,
				pattern: "markerbodyline1",
			},
			ctx,
			bindings,
		);
		expect(grepRes.result).toMatchObject({
			status: "ok",
			matches: [],
			withheld_files: 1,
		});
	});

	test("budget-discarded read_file does not satisfy requiredInspectPaths", async () => {
		const bigA = path.join(workspace, "bigA.txt");
		const bigB = path.join(workspace, "bigB.txt");
		const bigC = path.join(workspace, "bigC.txt");
		const script = path.join(workspace, "run.sh");
		const chunk = `${"a".repeat(3800)}\n`;
		writeFileSync(bigA, chunk);
		writeFileSync(bigB, chunk);
		writeFileSync(bigC, chunk);
		writeFileSync(script, `#!/bin/sh\n# ${"x".repeat(3000)}\necho ok\n`, {
			mode: 0o755,
		});
		const request = makeRequest({
			source: "./run.sh",
			escalation: "unsandboxed",
			operations: [{ argv: ["./run.sh"] }],
		});
		const ctx = buildReviewInspectContext(request, workspace);
		expect(ctx.requiredInspectPaths).toEqual([script]);
		let step = 0;
		const outcome = await runInspectableApprovalReview({
			request,
			initialPacket: JSON.stringify({ request_id: request.id }),
			ctx,
			signal: new AbortController().signal,
			stillCurrent: () => true,
			runStep: async () => {
				step += 1;
				if (step === 1) {
					return {
						request_id: request.id,
						decision: "inspect",
						reason: "Read large files then script",
						inspect_requests: [
							{
								kind: "read_file",
								path: "bigA.txt",
								start_line: 1,
								end_line: 10,
								pattern: null,
							},
							{
								kind: "read_file",
								path: "bigB.txt",
								start_line: 1,
								end_line: 10,
								pattern: null,
							},
							{
								kind: "read_file",
								path: "bigC.txt",
								start_line: 1,
								end_line: 10,
								pattern: null,
							},
							{
								kind: "read_file",
								path: "run.sh",
								start_line: 1,
								end_line: 10,
								pattern: null,
							},
						],
					};
				}
				return {
					request_id: request.id,
					decision: "allow_once",
					reason: "Looks ok",
					inspect_requests: [],
				};
			},
		});
		expect(outcome.decision).toMatchObject({
			decision: "insufficient_evidence",
		});
	});

	test("directory grep revalidates symlinked requestedPath when retargeted", async () => {
		const dirA = path.join(workspace, "dir-a");
		const dirB = path.join(workspace, "dir-b");
		const link = path.join(workspace, "linked-dir");
		mkdirSync(dirA);
		mkdirSync(dirB);
		writeFileSync(path.join(dirA, "a.txt"), "hello world\n");
		writeFileSync(path.join(dirB, "b.txt"), "hello evil\n");
		symlinkSync(dirA, link);
		const ctx = buildReviewInspectContext(
			makeRequest({ source: "ls", operations: [{ argv: ["ls"] }] }),
			workspace,
		);
		const bindings = new Map<string, InspectedBinding>();
		await executeReviewInspection(
			{
				kind: "grep",
				path: "linked-dir",
				start_line: null,
				end_line: null,
				pattern: "hello",
			},
			ctx,
			bindings,
		);
		expect(verifyInspectedBindings([...bindings.values()])).toBe(true);
		rmSync(link);
		symlinkSync(dirB, link);
		expect(verifyInspectedBindings([...bindings.values()])).toBe(false);
	});

	test("tracks requiredInspectPaths for leading cd, bare workspace PATH commands, and interpreter scripts; routes destructive HTTP options and non-workspace scripts to human", async () => {
		const subdir = path.join(workspace, "subdir");
		const localBin = path.join(workspace, "bin");
		mkdirSync(subdir, { recursive: true });
		mkdirSync(localBin, { recursive: true });
		const subScript = path.join(subdir, "deploy.sh");
		const pyScript = path.join(workspace, "check.py");
		const outsidePy = path.join(external, "outside.py");
		const bareTool = path.join(localBin, "ws-tool");
		writeFileSync(subScript, "#!/bin/sh\necho ok\n", { mode: 0o755 });
		writeFileSync(pyScript, "print('ok')\n");
		writeFileSync(outsidePy, "print('outside')\n");
		writeFileSync(bareTool, "#!/bin/sh\necho bare\n", { mode: 0o755 });

		const cdCtx = buildReviewInspectContext(
			makeRequest({
				source: "cd subdir && ./deploy.sh",
				escalation: "unsandboxed",
				reviewedDirectory: subdir,
				operations: [{ argv: ["cd", "subdir"] }, { argv: ["./deploy.sh"] }],
			}),
			workspace,
		);
		expect(cdCtx.requiredInspectPaths).toEqual([subScript]);

		const bareAndPyCtx = buildReviewInspectContext(
			makeRequest({
				source: "ws-tool && python3 check.py",
				escalation: "unsandboxed",
				binPaths: [localBin, "/usr/bin", "/bin"],
				operations: [{ argv: ["ws-tool"] }, { argv: ["python3", "check.py"] }],
			}),
			workspace,
		);
		expect(bareAndPyCtx.requiredInspectPaths).toEqual([bareTool, pyScript]);

		// Escalated curl -X DELETE, python3 -m, and outside-workspace python script stay human-only.
		let reviewCalls = 0;
		let humanCalls = 0;
		const dummyBackend: ProtectedShellBackend = {
			supportsReadOnlyPaths: true,
			supportsHomeDotProtection: true,
			supportsCommandBinding: true,
			supports: () => true,
			launch: () =>
				({
					stdout: null,
					stderr: null,
				}) as unknown as ShellChild,
		};
		const review: ReviewAdapter = {
			categories: ["local_shell", "local_test"],
			buildEvidence: async (req) =>
				buildLocalShellEvidence(req, workspace, {
					original: "run requested command",
					corrections: [],
				}),
			review: async (_packet, _signal, req) => {
				reviewCalls += 1;
				return {
					request_id: req.id,
					decision: "allow_once",
					reason: "allowed",
				};
			},
		};
		const authorize = createShellAuthorizer({
			root: workspace,
			sandboxMode: "workspace-write",
			backend: dummyBackend,
			escalationBackend: dummyBackend,
			autoReviewEnabled: () => true,
			authority: {
				investigation: true,
				workspaceWrite: "granted",
				stdinPipe: "confirm",
			},
			dispatcher: new ApprovalDispatcher({
				review,
				confirmation: {
					confirm: async () => {
						humanCalls += 1;
						return { decision: "deny" };
					},
				},
			}),
		});
		for (const source of [
			"curl -X DELETE https://api.example.com/items/1",
			"curl --request=DELETE https://api.example.com/items/1",
			"python3 -m http.server 8000",
			`python3 ${outsidePy}`,
		]) {
			await expect(
				authorize(
					{
						cwd: workspace,
						origin: "parent_agent",
						source,
						escalation: "unsandboxed",
					},
					(admit) => admit(),
				),
			).rejects.toThrow("Permission denied");
		}
		expect(reviewCalls).toBe(0);
		expect(humanCalls).toBe(4);
	});
});
