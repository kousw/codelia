import { randomUUID } from "node:crypto";
import type { SubagentChannel } from "./contracts";

export const createChildChannel = (send: (value: unknown) => void) => {
	let closed = false;
	const pending = new Map<
		string,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	const channel: SubagentChannel = {
		request(operation, params, signal) {
			if (closed || signal?.aborted)
				return Promise.reject(new Error("Child request aborted"));
			if (pending.size >= 32)
				return Promise.reject(new Error("Too many child requests"));
			return new Promise((resolve, reject) => {
				const id = `child-${randomUUID()}`;
				const cleanup = () => {
					pending.delete(id);
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				};
				const abort = () => {
					cleanup();
					reject(new Error("Child request aborted"));
				};
				const timer = setTimeout(
					() => {
						cleanup();
						reject(new Error("Parent request timed out"));
					},
					operation === "shell" ? 310000 : 125000,
				);
				pending.set(id, {
					resolve: (value) => {
						cleanup();
						resolve(value);
					},
					reject: (error) => {
						cleanup();
						reject(error);
					},
				});
				signal?.addEventListener("abort", abort, { once: true });
				const message = {
					jsonrpc: "2.0",
					id,
					method: "subagent.request",
					params: { operation, params },
				};
				try {
					if (Buffer.byteLength(JSON.stringify(message)) > 240 * 1024)
						throw new Error("Child request exceeds transport limit");
					send(message);
				} catch (error) {
					cleanup();
					reject(error);
				}
			});
		},
	};
	return {
		channel,
		handleResponse(message: {
			id?: unknown;
			result?: unknown;
			error?: unknown;
		}): boolean {
			if (typeof message.id !== "string" || !message.id.startsWith("child-"))
				return false;
			const request = pending.get(message.id);
			if (request) {
				if (message.error)
					request.reject(
						new Error(
							typeof message.error === "object" &&
								message.error &&
								"message" in message.error
								? String(message.error.message)
								: "Parent request failed",
						),
					);
				else request.resolve(message.result);
			}
			return true;
		},
		close() {
			closed = true;
			for (const request of pending.values())
				request.reject(new Error("Parent connection closed"));
		},
	};
};
