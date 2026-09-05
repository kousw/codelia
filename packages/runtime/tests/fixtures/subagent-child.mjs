// Deterministic transport peer for process ownership tests; never contacts a provider.
import { createReadStream } from "node:fs";

const bootstrap = createReadStream("", { fd: 3 });
let buffer = "";
let input;
bootstrap.on("end", () => process.exit(0));
bootstrap.on("data", (chunk) => {
	buffer += chunk;
	const i = buffer.indexOf("\n");
	if (i >= 0 && !input) input = JSON.parse(buffer.slice(0, i));
});
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let rpc = "";
process.stdin.on("data", (chunk) => {
	rpc += chunk;
	let i = rpc.indexOf("\n");
	while (i >= 0) {
		const msg = JSON.parse(rpc.slice(0, i));
		rpc = rpc.slice(i + 1);
		if (msg.method === "initialize") send({ id: msg.id, result: {} });
		if (msg.method === "run.start") {
			send({
				id: msg.id,
				result: { run_id: "child-run", session_id: "child-session" },
			});
			send({
				method: "subagent.progress",
				params: { usage: { total_tokens: 12 } },
			});
			if (input.prompt.startsWith("edit:"))
				send({
					id: "child-edit",
					method: "subagent.request",
					params: {
						operation: "edit",
						params: JSON.parse(input.prompt.slice(5)),
					},
				});
			if (input.prompt === "conversation")
				send({
					id: "child-send",
					method: "subagent.request",
					params: {
						operation: "send",
						params: { recipient: "parent", content: "Who owns parser.ts?" },
					},
				});
			if (input.prompt === "complete") {
				send({
					method: "subagent.result",
					params: {
						state: "completed",
						result: {
							termination_reason: "normal",
							summary: "fixture result",
							child_session_id: "child-session",
							usage: { total_tokens: 12 },
						},
					},
				});
				setTimeout(() => process.exit(0), 50);
			}
		}
		if (msg.id === "child-send")
			send({
				id: "child-receive",
				method: "subagent.request",
				params: { operation: "receive", params: { wait_seconds: 120 } },
			});
		if (msg.id === "child-receive" || msg.id === "child-edit") {
			send({
				method: "subagent.result",
				params: {
					state: "completed",
					result: {
						termination_reason: "normal",
						summary: JSON.stringify(msg.error ?? msg.result),
					},
				},
			});
			setTimeout(() => process.exit(0), 10);
		}
		i = rpc.indexOf("\n");
	}
});
