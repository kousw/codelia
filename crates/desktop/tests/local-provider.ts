/** Deterministic loopback Responses provider. Used with the REAL Codelia runtime.
 * No external API or real credential is used. This is a test model, not a runtime mock.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const fixtureRoot = resolve(process.argv[2] ?? "tmp/desktop-smoke");
await mkdir(`${fixtureRoot}/workspace/.codelia`, { recursive: true });
await mkdir(`${fixtureRoot}/config/codelia`, { recursive: true });
const config = {
	version: 1,
	model: {
		provider: "openai",
		name: "gpt-6.1-sol",
		experimental: { openai: { websocket_mode: "off" } },
	},
	skills: { enabled: false },
	execution_environment: { startup_checks: { enabled: false } },
};
await writeFile(
	`${fixtureRoot}/config/codelia/config.json`,
	JSON.stringify(config),
);
await writeFile(
	`${fixtureRoot}/workspace/README.md`,
	"# Desktop smoke workspace\nThis disposable workspace verifies native Codelia flows.\n",
);
let sequence = 0;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.CODELIA_SMOKE_PORT ?? "0"),
	async fetch(request) {
		const url = new URL(request.url);
		if (!url.pathname.endsWith("/responses"))
			return Response.json(
				{ error: { message: "Unsupported fixture endpoint" } },
				{ status: 404 },
			);
		const body = (await request.json()) as {
			input?: Array<Record<string, unknown>>;
		};
		const input = body.input ?? [];
		const user = input.filter((item) => item.role === "user").at(-1);
		const text = JSON.stringify(user ?? {});
		if (text.includes("native-smoke:thread-")) {
			const history = JSON.stringify(input);
			await appendFile(
				`${fixtureRoot}/thread-probes.jsonl`,
				`${JSON.stringify({ first: history.includes("native-smoke:thread-first"), second: history.includes("native-smoke:thread-second"), other: history.includes("native-smoke:thread-other"), followup: history.includes("native-smoke:thread-followup") })}\n`,
			);
		}
		const lastUser = input.findLastIndex((item) => item.role === "user");
		const hasOutput = input
			.slice(lastUser + 1)
			.some((item) => item.type === "function_call_output");
		if (text.includes("native-smoke:error"))
			return Response.json(
				{
					error: {
						message: "Intentional local provider error",
						type: "invalid_request_error",
					},
				},
				{ status: 400 },
			);
		const id = `resp_fixture_${++sequence}`;
		const tool = (name: string, args: unknown) => ({
			type: "function_call",
			id: `fc_${sequence}_${name}_${JSON.stringify(args).length}`,
			call_id: `call_${sequence}_${name}_${JSON.stringify(args).length}`,
			name,
			arguments: JSON.stringify(args),
			status: "completed",
		});
		const message = (text: string) => ({
			type: "message",
			id: `msg_${sequence}`,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		});
		let output: unknown[];
		if (!hasOutput && text.includes("native-child:approval"))
			output = [
				tool("write", {
					file_path: "child-approved.txt",
					content: "Child approval succeeded.\n",
					expected_hash: "missing",
				}),
			];
		else if (!hasOutput && text.includes("native-smoke:child-approval"))
			output = [
				tool("task_spawn", {
					name: "approval-child",
					prompt: "native-child:approval",
					background: true,
					workspace_access: "read-write",
					max_steps: 3,
				}),
			];
		else if (!hasOutput && text.includes("native-smoke:multi"))
			output = [
				message("Starting two existing runtime children."),
				...["alpha", "beta"].map((name) =>
					tool("task_spawn", {
						name,
						prompt: "native-child:slow",
						background: true,
						workspace_access: "read-only",
						max_steps: 3,
					}),
				),
			];
		else if (
			hasOutput &&
			text.includes("native-smoke:multi") &&
			!input
				.slice(lastUser + 1)
				.some((item) => item.type === "function_call" && item.name === "write")
		)
			output = [
				tool("write", {
					file_path: "multi-approved.txt",
					content: "Parent approval while children run.\n",
				}),
			];
		else if (!hasOutput && text.includes("native-smoke:approval"))
			output = [
				message("I will request permission before writing the fixture file."),
				tool("write", {
					file_path: text.includes("again")
						? "approved-again.txt"
						: "approved.txt",
					content: "Native approval succeeded.\n",
				}),
			];
		else if (!hasOutput && text.includes("native-smoke:app"))
			output = [
				message(
					"Creating a draft through the shared native application command.",
				),
				tool("codelia_app", {
					action: "create_thread",
					title: "Review native layout",
				}),
			];
		else if (!hasOutput && text.includes("native-smoke:delegate"))
			output = [
				message("Delegating to the existing Codelia subagent runtime."),
				tool("task_spawn", {
					name: "native-reviewer",
					prompt: "Return exactly: Local child runtime completed.",
					background: true,
					workspace_access: "read-only",
					max_steps: 3,
				}),
			];
		else
			output = [
				message(
					text.includes("native-smoke:long")
						? Array.from(
								{ length: 160 },
								(_, i) =>
									`Line ${i + 1}: Japanese 日本語 / native transcript performance.\n`,
							).join("")
						: hasOutput
							? "The runtime tool completed. Inspect its actual result above."
							: "Native Codelia runtime conversation completed. 日本語も表示できます。",
				),
			];
		const streamProbe = text.includes("native-smoke:stream");
		const streamMarker = text.includes("native-smoke:stream-cancel")
			? "stream-cancel"
			: "stream";
		if (streamProbe) output = [message("Native partial complete.")];
		const response = {
			id,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status: "completed",
			model: "gpt-6.1-sol",
			output,
			error: null,
			incomplete_details: null,
			usage: {
				input_tokens: 100,
				output_tokens: 30,
				total_tokens: 130,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		};
		const stream = new ReadableStream({
			async start(controller) {
				const emit = (event: Record<string, unknown>) =>
					controller.enqueue(
						new TextEncoder().encode(
							`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
						),
					);
				emit({
					type: "response.created",
					sequence_number: 0,
					response: { ...response, status: "in_progress", output: [] },
				});
				let n = 1;
				for (let index = 0; index < output.length; index++) {
					const item = output[index] as Record<string, unknown>;
					emit({
						type: "response.output_item.added",
						sequence_number: n++,
						output_index: index,
						item: streamProbe
							? { ...item, status: "in_progress", content: [] }
							: item,
					});
					if (streamProbe) {
						emit({
							type: "response.content_part.added",
							sequence_number: n++,
							item_id: item.id,
							output_index: index,
							content_index: 0,
							part: { type: "output_text", text: "", annotations: [] },
						});
						emit({
							type: "response.output_text.delta",
							sequence_number: n++,
							item_id: item.id,
							output_index: index,
							content_index: 0,
							delta: "Native partial",
						});
						await writeFile(
							`${fixtureRoot}/${streamMarker}-first-delta`,
							"emitted",
						);
						for (
							let attempt = 0;
							attempt < 200 &&
							!existsSync(`${fixtureRoot}/${streamMarker}-release`);
							attempt++
						)
							await Bun.sleep(25);
						emit({
							type: "response.output_text.delta",
							sequence_number: n++,
							item_id: item.id,
							output_index: index,
							content_index: 0,
							delta: " complete.",
						});
						emit({
							type: "response.output_text.done",
							sequence_number: n++,
							item_id: item.id,
							output_index: index,
							content_index: 0,
							text: "Native partial complete.",
						});
					}
					emit({
						type: "response.output_item.done",
						sequence_number: n++,
						output_index: index,
						item,
					});
				}
				if (
					text.includes("native-smoke:slow") ||
					text.includes("native-child:slow")
				)
					await Bun.sleep(12000);
				emit({ type: "response.completed", sequence_number: n, response });
				controller.close();
			},
		});
		return new Response(stream, {
			headers: { "Content-Type": "text/event-stream" },
		});
	},
});
await writeFile(
	`${fixtureRoot}/provider.json`,
	JSON.stringify({
		url: `http://127.0.0.1:${server.port}/v1`,
		root: fixtureRoot,
	}),
);
console.log(
	`Local fixture provider ready at 127.0.0.1:${server.port}; no external API used`,
);
process.on("SIGTERM", () => {
	server.stop(true);
	process.exit(0);
});

const stopWatch = setInterval(() => {
	if (existsSync(`${fixtureRoot}/provider-stop`)) {
		clearInterval(stopWatch);
		server.stop(true);
		process.exit(0);
	}
}, 100);
