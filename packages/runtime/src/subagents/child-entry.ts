import { createReadStream } from "node:fs";
import { AuthResolver } from "../auth/resolver";
import { createRuntimeModel } from "../model-factory";
import { RuntimeState } from "../runtime-state";
import { subagentBootstrapSchema } from "./bootstrap";
import { createChildChannel } from "./child-channel";
import { createChildRun } from "./child-runtime";

// A dedicated entrypoint: never invokes normal runtime startup or project config.
const bootstrap = createReadStream("", { fd: 3, autoClose: false });
bootstrap.setEncoding("utf8");
const controller = new AbortController();
let exitTimer: ReturnType<typeof setTimeout> | undefined;
const stop = () => {
	controller.abort();
	bridge.close();
	if (!exitTimer) exitTimer = setTimeout(() => process.exit(1), 1000);
};
bootstrap.on("end", stop);
bootstrap.on("error", stop);
process.stdin.on("end", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const startupTimer = setTimeout(() => process.exit(1), 30_000);
const send = (value: unknown) =>
	process.stdout.write(`${JSON.stringify(value)}\n`);
const finish = (value: unknown) =>
	process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0));

const bridge = createChildChannel(send);

const main = async () => {
	const manifest = await new Promise<unknown>((resolve, reject) => {
		let buffer = "";
		const receive = (chunk: string) => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 256 * 1024) {
				reject(new Error("bootstrap too large"));
				bootstrap.off("data", receive);
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			bootstrap.off("data", receive);
			try {
				resolve(JSON.parse(buffer.slice(0, newline)));
			} catch {
				reject(new Error("invalid bootstrap"));
			}
		};
		bootstrap.on("data", receive);
	});
	const input = subagentBootstrapSchema.parse(manifest);
	controller.signal.throwIfAborted();
	let initialized = false;
	let started = false;
	let child: Awaited<ReturnType<typeof createChildRun>> | undefined;
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		if (Buffer.byteLength(buffer) > 256 * 1024) {
			stop();
			return;
		}
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			void dispatch(line).catch(() =>
				finish({
					jsonrpc: "2.0",
					method: "subagent.result",
					params: {
						state: "failed",
						result: {
							termination_reason: child ? "execution_error" : "startup_error",
						},
						failure_message: "Subagent initialization failed",
					},
				}),
			);
			newline = buffer.indexOf("\n");
		}
	});
	const dispatch = async (line: string) => {
		const request = JSON.parse(line);
		if (bridge.handleResponse(request)) return;
		if (request.method === "initialize" && !initialized) {
			initialized = true;
			send({
				jsonrpc: "2.0",
				id: request.id,
				result: { server_capabilities: { supported_task_kinds: [] } },
			});
			return;
		}
		if (request.method === "run.cancel") {
			stop();
			send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
			return;
		}
		if (
			request.method !== "run.start" ||
			!initialized ||
			started ||
			request.params?.session_id ||
			request.params?.tools
		) {
			send({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32602, message: "Unsupported delegated request" },
			});
			return;
		}
		started = true;
		// No UI capabilities: auth resolution may use existing credentials but cannot prompt.
		const auth = await AuthResolver.create(new RuntimeState(), () => {});
		const providerAuth = await auth.resolveProviderAuth(input.model.provider);
		const secrets =
			providerAuth.method === "api_key"
				? [providerAuth.api_key]
				: [
						providerAuth.oauth.access_token,
						providerAuth.oauth.refresh_token,
						providerAuth.oauth.account_id ?? "",
					];
		const { llm } = await createRuntimeModel({
			provider: input.model.provider,
			config: input.model,
			auth: providerAuth,
			useMetadata: false,
			log: () => {},
			getOpenAiAccessToken: () => auth.getOpenAiAccessToken(),
		});
		controller.signal.throwIfAborted();
		child = await createChildRun(input, llm, {
			secrets,
			channel: bridge.channel,
			progress: (usage) => {
				send({
					jsonrpc: "2.0",
					method: "subagent.progress",
					params: { usage },
				});
			},
		});
		controller.signal.throwIfAborted();
		clearTimeout(startupTimer);
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: { run_id: child.run_id, session_id: child.session_id },
		});
		const result = await child.execute(controller.signal);
		finish({ jsonrpc: "2.0", method: "subagent.result", params: result });
	};
};
void main().catch(() =>
	finish({
		jsonrpc: "2.0",
		method: "subagent.result",
		params: {
			state: "failed",
			result: { termination_reason: "startup_error" },
			failure_message: "Invalid or unavailable subagent bootstrap",
		},
	}),
);
