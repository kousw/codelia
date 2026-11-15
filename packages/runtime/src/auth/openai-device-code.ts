import { type OAuthPkce, readPositiveIntEnv } from "./oauth-utils";
import {
	exchangeCodeForTokens,
	type OpenAiTokenResponse,
} from "./openai-oauth";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 5;

type DeviceCodePollResponse = {
	authorization_code: string;
	code_challenge: string;
	code_verifier: string;
};

export type OpenAiDeviceCodeSession = {
	verificationUrl: string;
	userCode: string;
	/** Polls until authorized; rejects with "device code login cancelled" on abort. */
	complete: (signal?: AbortSignal) => Promise<OpenAiTokenResponse>;
};

const clientId = (): string =>
	process.env.CODELIA_OPENAI_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;

const deviceCodeTimeoutMs = (): number =>
	readPositiveIntEnv(
		"CODELIA_OPENAI_DEVICE_CODE_TIMEOUT_MS",
		DEFAULT_TIMEOUT_MS,
	);

const cancelledError = (): Error => new Error("device code login cancelled");

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(cancelledError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(cancelledError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseIntervalSeconds = (value: unknown): number => {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			return parsed;
		}
	}
	return DEFAULT_INTERVAL_SECONDS;
};

const readResponseSnippet = async (response: Response): Promise<string> => {
	const text = await response.text().catch(() => "");
	return text ? text.slice(0, 500) : "(empty)";
};

const requestDeviceCodeStart = async (): Promise<{
	deviceAuthId: string;
	userCode: string;
	intervalSeconds: number;
}> => {
	const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ client_id: clientId() }),
	});
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				"OpenAI device code login is not enabled for this client",
			);
		}
		throw new Error(
			`OpenAI device code request failed (${response.status}): ${await readResponseSnippet(response)}`,
		);
	}
	const payload = (await response.json()) as unknown;
	if (!isRecord(payload) || typeof payload.device_auth_id !== "string") {
		throw new Error("OpenAI device code response is missing device_auth_id");
	}
	const userCode =
		(typeof payload.user_code === "string" && payload.user_code.trim()) ||
		(typeof payload.usercode === "string" && payload.usercode.trim()) ||
		null;
	if (!userCode) {
		throw new Error("OpenAI device code response is missing user_code");
	}
	return {
		deviceAuthId: payload.device_auth_id,
		userCode,
		intervalSeconds: parseIntervalSeconds(payload.interval),
	};
};

const pollDeviceCodeAuthorization = async (
	deviceAuthId: string,
	userCode: string,
	intervalSeconds: number,
	signal?: AbortSignal,
): Promise<DeviceCodePollResponse> => {
	const deadline = Date.now() + deviceCodeTimeoutMs();
	while (Date.now() < deadline) {
		if (signal?.aborted) throw cancelledError();
		const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
			method: "POST",
			...(signal ? { signal } : {}),
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				device_auth_id: deviceAuthId,
				user_code: userCode,
			}),
		});
		if (response.ok) {
			const payload = (await response.json()) as unknown;
			if (
				!isRecord(payload) ||
				typeof payload.authorization_code !== "string" ||
				typeof payload.code_challenge !== "string" ||
				typeof payload.code_verifier !== "string"
			) {
				throw new Error(
					"OpenAI device code token response is missing authorization_code/PKCE fields",
				);
			}
			return {
				authorization_code: payload.authorization_code,
				code_challenge: payload.code_challenge,
				code_verifier: payload.code_verifier,
			};
		}
		if (response.status !== 403 && response.status !== 404) {
			throw new Error(
				`OpenAI device code polling failed (${response.status}): ${await readResponseSnippet(response)}`,
			);
		}
		const now = Date.now();
		if (now >= deadline) {
			break;
		}
		const waitMs = Math.max(
			0,
			Math.min(intervalSeconds * 1000, deadline - now),
		);
		await sleep(waitMs, signal);
	}
	throw new Error("OpenAI device code login timed out after 15 minutes");
};

export const createOpenAiDeviceCodeSession =
	async (): Promise<OpenAiDeviceCodeSession> => {
		const start = await requestDeviceCodeStart();
		return {
			verificationUrl: `${ISSUER}/codex/device`,
			userCode: start.userCode,
			complete: async (signal) => {
				const authCode = await pollDeviceCodeAuthorization(
					start.deviceAuthId,
					start.userCode,
					start.intervalSeconds,
					signal,
				).catch((error: unknown) => {
					if (signal?.aborted) throw cancelledError();
					throw error;
				});
				if (signal?.aborted) throw cancelledError();
				const pkce: OAuthPkce = {
					challenge: authCode.code_challenge,
					verifier: authCode.code_verifier,
				};
				return exchangeCodeForTokens(
					authCode.authorization_code,
					`${ISSUER}/deviceauth/callback`,
					pkce,
				);
			},
		};
	};
