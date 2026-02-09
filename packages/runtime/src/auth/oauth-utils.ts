import { createServer } from "node:http";
import * as oauth from "oauth4webapi";

export type OAuthPkce = {
	verifier: string;
	challenge: string;
};

export type OAuthCallbackServerOptions<TResult> = {
	port: number;
	callbackPath: string;
	cancelPath: string;
	expectedState: string;
	successHtml: string;
	errorHtml: (message: string) => string;
	onCode: (code: string) => Promise<TResult>;
	timeoutMs?: number;
	timeoutMessage?: string;
	invalidStateMessage?: string;
	cancelMessage?: string;
	onServerError?: (error: unknown) => void;
};

export type OAuthCallbackServerSession<TResult> = {
	waitForResult: () => Promise<TResult>;
	stop: () => void;
};

export const generatePkce = async (): Promise<OAuthPkce> => {
	const verifier = oauth.generateRandomCodeVerifier();
	const challenge = await oauth.calculatePKCECodeChallenge(verifier);
	return { verifier, challenge };
};

export const generateState = (): string => oauth.generateRandomState();

export const readPositiveIntEnv = (key: string, fallback: number): number => {
	const value = process.env[key];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
};

const asError = (value: unknown): Error =>
	value instanceof Error ? value : new Error(String(value));

const readString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

export const startOAuthCallbackServer = <TResult>(
	options: OAuthCallbackServerOptions<TResult>,
): OAuthCallbackServerSession<TResult> => {
	let resolveResult: ((value: TResult) => void) | null = null;
	let rejectResult: ((error: Error) => void) | null = null;
	let settled = false;
	let settledValue!: TResult;
	let hasSettledValue = false;
	let settledError: Error | null = null;

	const finishResolve = (value: TResult) => {
		if (settled) return;
		settled = true;
		settledValue = value;
		hasSettledValue = true;
		resolveResult?.(value);
	};
	const finishReject = (error: unknown) => {
		if (settled) return;
		settled = true;
		settledError = asError(error);
		rejectResult?.(settledError);
	};

	const waitForResult = () =>
		new Promise<TResult>((resolve, reject) => {
			if (settledError) {
				reject(settledError);
				return;
			}
			if (hasSettledValue) {
				resolve(settledValue);
				return;
			}
			resolveResult = resolve;
			rejectResult = reject;
		});

	const timeoutMs = options.timeoutMs;
	const timeoutId =
		timeoutMs && timeoutMs > 0
			? setTimeout(() => {
					finishReject(
						new Error(
							options.timeoutMessage ??
								`OAuth timed out waiting for callback (${Math.round(timeoutMs / 1000)}s)`,
						),
					);
				}, timeoutMs)
			: null;

	const clearWaitTimeout = () => {
		if (timeoutId) clearTimeout(timeoutId);
	};

	const server = createServer(async (request, response) => {
		const sendResponse = (
			status: number,
			body: string,
			contentType: string,
		) => {
			response.statusCode = status;
			response.setHeader("Content-Type", contentType);
			response.end(body);
		};
		try {
			const requestUrl = new URL(
				request.url ?? "/",
				`http://${request.headers.host ?? "localhost"}`,
			);
			if (requestUrl.pathname === options.callbackPath) {
				const code = readString(requestUrl.searchParams.get("code"));
				const returnedState = readString(requestUrl.searchParams.get("state"));
				const oauthError = readString(requestUrl.searchParams.get("error"));
				const errorDescription =
					readString(requestUrl.searchParams.get("error_description")) ?? "";
				if (oauthError) {
					const message = errorDescription || oauthError;
					clearWaitTimeout();
					finishReject(new Error(message));
					sendResponse(400, options.errorHtml(message), "text/html");
					return;
				}
				if (!code) {
					const message = "missing authorization code";
					clearWaitTimeout();
					finishReject(new Error(message));
					sendResponse(400, options.errorHtml(message), "text/html");
					return;
				}
				if (returnedState !== options.expectedState) {
					const message = options.invalidStateMessage ?? "invalid state";
					clearWaitTimeout();
					finishReject(new Error(message));
					sendResponse(400, options.errorHtml(message), "text/html");
					return;
				}
				try {
					const result = await options.onCode(code);
					clearWaitTimeout();
					finishResolve(result);
					sendResponse(200, options.successHtml, "text/html");
					return;
				} catch (error) {
					const message = asError(error).message;
					clearWaitTimeout();
					finishReject(new Error(message));
					sendResponse(500, options.errorHtml(message), "text/html");
					return;
				}
			}
			if (requestUrl.pathname === options.cancelPath) {
				clearWaitTimeout();
				finishReject(new Error(options.cancelMessage ?? "oauth cancelled"));
				sendResponse(200, "cancelled", "text/plain");
				return;
			}
			sendResponse(404, "not found", "text/plain");
		} catch (error) {
			options.onServerError?.(error);
			clearWaitTimeout();
			finishReject(error);
			sendResponse(500, "server error", "text/plain");
		}
	});
	server.on("error", (error) => {
		options.onServerError?.(error);
		clearWaitTimeout();
		finishReject(error);
	});
	server.listen(options.port);

	return {
		waitForResult,
		stop: () => {
			clearWaitTimeout();
			finishReject(new Error(options.cancelMessage ?? "oauth cancelled"));
			server.close();
		},
	};
};
