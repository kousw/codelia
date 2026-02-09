import type { AgentEvent, SessionSummary } from "../shared/types";

// ── SSE streaming client ──

export type SSECallback = {
	onOpen?: () => void;
	onEvent: (event: AgentEvent) => void;
	onDone: (status: string) => void;
	onError: (message: string) => void;
};

const CONNECT_TIMEOUT_MS = 20_000;
const FIRST_EVENT_TIMEOUT_MS = 90_000;
const STALL_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

const isAbortError = (error: unknown): boolean => {
	if (error instanceof Error && error.name === "AbortError") return true;
	return false;
};

const sleep = async (delayMs: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new DOMException("aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

export const createRun = async (
	sessionId: string,
	message: string,
	signal?: AbortSignal,
): Promise<{ runId: string }> => {
	const res = await fetch("/api/runs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			session_id: sessionId,
			message,
		}),
		signal,
	});
	if (!res.ok) {
		throw new Error(`Failed to create run: HTTP ${res.status}`);
	}
	const data = (await res.json()) as { run_id?: string };
	if (!data.run_id) {
		throw new Error("Failed to create run: missing run_id");
	}
	return { runId: data.run_id };
};

export const streamRunEvents = async (
	runId: string,
	callbacks: SSECallback,
	signal?: AbortSignal,
): Promise<void> => {
	let lastEventId = -1;
	let reconnectAttempts = 0;
	let opened = false;
	let finished = false;
	let sawAgentEvent = false;

	const safeComplete = (status: string) => {
		if (finished) return;
		finished = true;
		callbacks.onDone(status);
	};

	const failIfUnfinished = (message: string) => {
		if (finished) return;
		callbacks.onError(message);
		safeComplete("error");
	};

	while (!finished) {
		if (signal?.aborted) break;
		const connectTimeoutController = new AbortController();
		const connectTimeout = setTimeout(() => {
			connectTimeoutController.abort(
				new Error("Connection timed out before response started"),
			);
		}, CONNECT_TIMEOUT_MS);

		const combinedSignal = signal
			? AbortSignal.any([signal, connectTimeoutController.signal])
			: connectTimeoutController.signal;

		let response: Response;
		try {
			response = await fetch(`/api/runs/${runId}/events`, {
				method: "GET",
				headers: {
					Accept: "text/event-stream",
					...(lastEventId >= 0 ? { "Last-Event-ID": String(lastEventId) } : {}),
				},
				signal: combinedSignal,
			});
		} catch (error) {
			clearTimeout(connectTimeout);
			if (isAbortError(error) || signal?.aborted) break;
			if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
				failIfUnfinished(
					error instanceof Error ? error.message : String(error),
				);
				break;
			}
			reconnectAttempts += 1;
			await sleep(250 * reconnectAttempts, signal).catch(() => {});
			continue;
		}
		clearTimeout(connectTimeout);

		if (!response.ok || !response.body) {
			failIfUnfinished(`HTTP ${response.status}: ${response.statusText}`);
			break;
		}
		if (!opened) {
			opened = true;
			callbacks.onOpen?.();
		}
		reconnectAttempts = 0;

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let streamDisconnected = false;
		let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
		let stallTimer: ReturnType<typeof setTimeout> | null = null;

		const clearFirstEventTimer = () => {
			if (!firstEventTimer) return;
			clearTimeout(firstEventTimer);
			firstEventTimer = null;
		};
		const clearStallTimer = () => {
			if (!stallTimer) return;
			clearTimeout(stallTimer);
			stallTimer = null;
		};
		const resetStallTimer = () => {
			clearStallTimer();
			stallTimer = setTimeout(() => {
				failIfUnfinished("Connection stalled — no data received");
				reader.cancel().catch(() => {});
			}, STALL_TIMEOUT_MS);
		};
		firstEventTimer = setTimeout(() => {
			if (sawAgentEvent || finished) return;
			failIfUnfinished("No response event received from server");
			reader.cancel().catch(() => {});
		}, FIRST_EVENT_TIMEOUT_MS);
		resetStallTimer();

		const handleFrame = (frame: string) => {
			if (!frame) return;
			let eventType = "";
			let frameEventId: number | null = null;
			const dataLines: string[] = [];

			for (const rawLine of frame.split("\n")) {
				if (!rawLine || rawLine.startsWith(":")) continue;
				if (rawLine.startsWith("id:")) {
					const parsed = Number(rawLine.slice(3).trim());
					if (Number.isFinite(parsed)) {
						frameEventId = Math.floor(parsed);
					}
					continue;
				}
				if (rawLine.startsWith("event:")) {
					eventType = rawLine.slice(6).replace(/^ /, "");
					continue;
				}
				if (rawLine.startsWith("data:")) {
					dataLines.push(rawLine.slice(5).replace(/^ /, ""));
				}
			}

			if (frameEventId !== null) {
				lastEventId = Math.max(lastEventId, frameEventId);
			}
			if (eventType === "ping") return;

			const data = dataLines.join("\n");
			if (!data) return;
			try {
				const parsed = JSON.parse(data);
				if (eventType === "done") {
					clearFirstEventTimer();
					safeComplete(
						typeof parsed.status === "string" ? parsed.status : "completed",
					);
					return;
				}
				if (eventType === "error") {
					clearFirstEventTimer();
					callbacks.onError(
						typeof parsed.message === "string"
							? parsed.message
							: "Unknown error",
					);
					safeComplete("error");
					return;
				}
				sawAgentEvent = true;
				clearFirstEventTimer();
				callbacks.onEvent(parsed as AgentEvent);
			} catch {
				// ignore malformed frame
			}
		};

		const drainFrames = (flush = false) => {
			buffer = buffer.replace(/\r\n/g, "\n");
			while (true) {
				const separator = buffer.indexOf("\n\n");
				if (separator === -1) break;
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				handleFrame(frame);
			}
			if (flush && buffer.trim().length > 0) {
				const frame = buffer;
				buffer = "";
				handleFrame(frame);
			}
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done || finished) break;
				resetStallTimer();
				buffer += decoder.decode(value, { stream: true });
				drainFrames();
			}
			if (!finished) {
				buffer += decoder.decode();
				drainFrames(true);
			}
			if (!finished && !signal?.aborted) {
				streamDisconnected = true;
			}
		} catch (error) {
			if (isAbortError(error) || signal?.aborted) {
				break;
			}
			streamDisconnected = true;
		} finally {
			clearFirstEventTimer();
			clearStallTimer();
		}

		if (finished || signal?.aborted) break;
		if (!streamDisconnected) continue;
		if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			failIfUnfinished("Connection closed before completion");
			break;
		}
		reconnectAttempts += 1;
		await sleep(250 * reconnectAttempts, signal).catch(() => {});
	}
};

export const streamChat = async (
	sessionId: string,
	message: string,
	callbacks: SSECallback,
	signal?: AbortSignal,
): Promise<{ runId: string }> => {
	const { runId } = await createRun(sessionId, message, signal);
	await streamRunEvents(runId, callbacks, signal);
	return { runId };
};

// ── REST API ──

export const fetchSessions = async (): Promise<SessionSummary[]> => {
	const res = await fetch("/api/sessions");
	if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
	return res.json();
};

export const createSession = async (): Promise<string> => {
	const res = await fetch("/api/sessions", { method: "POST" });
	if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
	const data = await res.json();
	return data.session_id;
};

export const fetchSessionState = async (
	sessionId: string,
): Promise<{ messages: Array<Record<string, unknown>> }> => {
	const res = await fetch(`/api/sessions/${sessionId}`);
	if (!res.ok) throw new Error(`Failed to fetch session: ${res.status}`);
	return res.json();
};

export type RunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type RunView = {
	run_id: string;
	session_id: string;
	input_text?: string;
	status: RunStatus;
	created_at: number;
	started_at?: number;
	finished_at?: number;
	cancel_requested_at?: number;
	error_message?: string;
};

export const fetchRunsBySession = async (
	sessionId: string,
	options: {
		statuses?: RunStatus[];
		limit?: number;
	} = {},
): Promise<RunView[]> => {
	const params = new URLSearchParams({ session_id: sessionId });
	if (options.statuses && options.statuses.length > 0) {
		params.set("statuses", options.statuses.join(","));
	}
	if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
		params.set("limit", String(Math.max(1, Math.floor(options.limit))));
	}
	const res = await fetch(`/api/runs?${params.toString()}`);
	if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
	const data = (await res.json()) as { runs?: RunView[] };
	return Array.isArray(data.runs) ? data.runs : [];
};

export const deleteSession = async (sessionId: string): Promise<void> => {
	const res = await fetch(`/api/sessions/${sessionId}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete session: ${res.status}`);
};

export const cancelRun = async (runId: string): Promise<void> => {
	await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
};

export type Provider = "openai" | "anthropic";
export type ReasoningEffort = "low" | "medium" | "high";

export type PublicSettings = {
	provider?: Provider;
	model?: string;
	reasoning?: ReasoningEffort;
	openai_api_key_set: boolean;
	openai_api_key_preview?: string;
	openai_oauth_connected: boolean;
	openai_oauth_expires_at?: number;
	openai_oauth_account_id?: string;
	anthropic_api_key_set: boolean;
	anthropic_api_key_preview?: string;
	updated_at?: string;
};

export type SettingsPatch = {
	provider?: Provider;
	model?: string;
	reasoning?: ReasoningEffort;
	clear_reasoning?: boolean;
	openai_api_key?: string;
	clear_openai_oauth?: boolean;
	anthropic_api_key?: string;
	clear_openai_api_key?: boolean;
	clear_anthropic_api_key?: boolean;
};

export const fetchSettings = async (): Promise<PublicSettings> => {
	const res = await fetch("/api/settings");
	if (!res.ok) throw new Error(`Failed to fetch settings: ${res.status}`);
	return res.json();
};

export const patchSettings = async (
	patch: SettingsPatch,
): Promise<PublicSettings> => {
	const res = await fetch("/api/settings", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`Failed to patch settings: ${res.status}`);
	return res.json();
};
