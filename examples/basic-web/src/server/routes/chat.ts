import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AgentPool } from "../agent/agent-pool";

const chatInput = z.object({
	message: z.string().min(1),
});

const HEARTBEAT_INTERVAL_MS = 5_000;

const isAbortLikeError = (error: Error): boolean =>
	error.name === "AbortError" ||
	error.name === "APIUserAbortError" ||
	/abort/i.test(error.message);

const toErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const createSseSender = (
	stream: {
		writeSSE: (event: {
			event?: string;
			data: string;
			id?: string;
		}) => Promise<void>;
	},
	requestId: string,
) => {
	let seq = 0;
	let closed = false;

	const sendEvent = async (
		type: string,
		data: Record<string, unknown>,
	): Promise<boolean> => {
		if (closed) return false;
		try {
			await stream.writeSSE({
				event: type,
				data: JSON.stringify(data),
				id: String(seq++),
			});
			if (type === "done" || type === "error") {
				console.log(
					`[chat][${requestId}] emit event=${type} payload=${JSON.stringify(data)}`,
				);
			}
			return true;
		} catch {
			closed = true;
			console.log(`[chat][${requestId}] stream write failed (closed)`);
			return false;
		}
	};

	return {
		sendEvent,
		isClosed: () => closed,
	};
};

export const createChatRoutes = (pool: AgentPool) => {
	const app = new Hono();

	app.post("/:sessionId", async (c) => {
		const sessionId = c.req.param("sessionId");
		const body = await c.req.json();
		const parsed = chatInput.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "Invalid input", details: parsed.error }, 400);
		}

		const { message } = parsed.data;
		const requestId = `${sessionId}-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		console.log(
			`[chat][${requestId}] start session=${sessionId} message_chars=${message.length}`,
		);

		return streamSSE(c, async (stream) => {
			let eventCount = 0;
			let outcome = "running";
			const requestSignal = c.req.raw.signal;
			const { sendEvent, isClosed } = createSseSender(stream, requestId);

			// Keep connection alive during long-running tool calls.
			const heartbeat = setInterval(async () => {
				const ok = await sendEvent("ping", {});
				if (!ok) clearInterval(heartbeat);
			}, HEARTBEAT_INTERVAL_MS);

			try {
				await pool.runWithLock(sessionId, async (entry) => {
					const abortController = new AbortController();
					entry.abortController = abortController;
					const abortOnDisconnect = () => {
						console.log(`[chat][${requestId}] client disconnected`);
						if (!abortController.signal.aborted) {
							abortController.abort(new Error("client disconnected"));
						}
					};
					requestSignal?.addEventListener("abort", abortOnDisconnect, {
						once: true,
					});
					if (requestSignal?.aborted) {
						abortOnDisconnect();
					}

					try {
						for await (const event of entry.agent.runStream(message, {
							signal: abortController.signal,
						})) {
							if (abortController.signal.aborted) break;
							eventCount += 1;
							if (eventCount === 1) {
								console.log(
									`[chat][${requestId}] first event type=${event.type}`,
								);
							}
							const sent = await sendEvent(
								event.type,
								event as Record<string, unknown>,
							);
							if (!sent) {
								if (!abortController.signal.aborted) {
									abortController.abort(new Error("sse connection closed"));
								}
								outcome = "stream_closed";
								break;
							}
						}
						if (!abortController.signal.aborted && !isClosed()) {
							await sendEvent("done", { status: "completed" });
							outcome = "completed";
						}
					} catch (error) {
						const err =
							error instanceof Error ? error : new Error(String(error));
						if (isAbortLikeError(err)) {
							outcome = "cancelled";
							if (!requestSignal?.aborted && !isClosed()) {
								await sendEvent("done", { status: "cancelled" });
							}
						} else {
							outcome = "error";
							console.error(`[chat][${requestId}] run error: ${err.message}`);
							if (!isClosed()) {
								await sendEvent("error", { message: err.message });
								await sendEvent("done", { status: "error" });
							}
						}
					} finally {
						requestSignal?.removeEventListener("abort", abortOnDisconnect);
						entry.abortController = null;
						try {
							await pool.saveSession(sessionId);
						} catch (error) {
							console.error(
								`[chat][${requestId}] session save error: ${String(error)}`,
							);
						}
					}
				});
			} catch (error) {
				outcome = "error";
				if (!isClosed()) {
					await sendEvent("error", { message: toErrorMessage(error) });
					await sendEvent("done", { status: "error" });
				}
			} finally {
				clearInterval(heartbeat);
				const elapsedMs = Date.now() - startedAt;
				console.log(
					`[chat][${requestId}] finish outcome=${outcome} events=${eventCount} elapsed_ms=${elapsedMs}`,
				);
			}
		});
	});

	return app;
};
