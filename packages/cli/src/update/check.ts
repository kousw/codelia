import {
	computeRegistryId,
	type FetchLike,
	fetchLatestVersion,
	resolveRegistryUrl,
} from "./registry";
import { inferChannelFromVersion, isNewerVersion } from "./semver";
import {
	clampMessage,
	mutateUpdateState,
	type UpdatePaths,
	type UpdateState,
} from "./state";

const CHECK_SUCCESS_TTL_MS = 2 * 60 * 60 * 1000;
const CHECK_FAILURE_TTL_MS = 5 * 60 * 1000;

export const resolveEffectiveChannel = (
	currentVersion: string,
	configuredChannel: string | null,
): string => configuredChannel ?? inferChannelFromVersion(currentVersion);

export type CheckScope = {
	channel: string;
	configuredChannel: string | null;
	registryId: string;
};

export const isMatchingCheckScope = (
	state: UpdateState,
	scope: CheckScope,
): boolean =>
	state.registry_id === scope.registryId &&
	state.channel === scope.channel &&
	state.configured_channel === scope.configuredChannel;

export const shouldCheckNow = (
	state: UpdateState,
	options: {
		now?: number;
		currentVersion: string;
		configuredChannel: string | null;
		registryId: string;
	},
): boolean => {
	const now = options.now ?? Date.now();
	const effectiveChannel = resolveEffectiveChannel(
		options.currentVersion,
		options.configuredChannel,
	);
	if (
		!isMatchingCheckScope(state, {
			channel: effectiveChannel,
			configuredChannel: options.configuredChannel,
			registryId: options.registryId,
		}) ||
		state.checked_version !== options.currentVersion
	) {
		return true;
	}
	if (!state.last_check_at) return true;
	const lastMs = Date.parse(state.last_check_at);
	if (!Number.isFinite(lastMs)) return true;
	const ttl =
		state.last_check_ok === true ? CHECK_SUCCESS_TTL_MS : CHECK_FAILURE_TTL_MS;
	return now - lastMs >= ttl;
};

export type RegistryCheckOutcome =
	| { status: "up_to_date"; channel: string; latest: string }
	| { status: "update_available"; channel: string; latest: string }
	| { status: "failed"; channel: string; message: string }
	| { status: "aborted"; channel: string };

export type RunRegistryCheckOptions = {
	paths: UpdatePaths;
	currentVersion: string;
	configuredChannel: string | null;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
	now?: () => number;
};

export const runRegistryCheck = async (
	options: RunRegistryCheckOptions,
): Promise<RegistryCheckOutcome> => {
	const now = options.now ?? Date.now;
	const channel = resolveEffectiveChannel(
		options.currentVersion,
		options.configuredChannel,
	);
	let registryUrl: string;
	try {
		registryUrl = resolveRegistryUrl(options.env);
	} catch (error) {
		const message = clampMessage(
			error instanceof Error ? error.message : String(error),
		);
		return { status: "failed", channel, message };
	}
	const regId = computeRegistryId(registryUrl);
	const checkedAt = new Date(now()).toISOString();

	try {
		const latest = await fetchLatestVersion({
			registryUrl,
			channel,
			fetchImpl: options.fetchImpl,
			signal: options.signal,
		});
		await mutateUpdateState(options.paths.stateFile, (state) => {
			const next: UpdateState = {
				...state,
				version: 1,
				last_check_at: checkedAt,
				last_check_ok: true,
				channel,
				registry_id: regId,
				configured_channel: options.configuredChannel,
				latest_version: latest,
				checked_version: options.currentVersion,
			};
			delete next.last_check_error;
			if (next.apply_failure && next.apply_failure.version !== latest) {
				delete next.apply_failure;
			}
			return next;
		});
		if (isNewerVersion(latest, options.currentVersion)) {
			return { status: "update_available", channel, latest };
		}
		return { status: "up_to_date", channel, latest };
	} catch (error) {
		if (options.signal?.aborted) {
			return { status: "aborted", channel };
		}
		const message = clampMessage(
			error instanceof Error ? error.message : String(error),
		);
		await mutateUpdateState(options.paths.stateFile, (state) => {
			const scopeChanged = !isMatchingCheckScope(state, {
				channel,
				configuredChannel: options.configuredChannel,
				registryId: regId,
			});
			const next: UpdateState = {
				...state,
				version: 1,
				last_check_at: checkedAt,
				last_check_ok: false,
				last_check_error: message,
				channel,
				registry_id: regId,
				configured_channel: options.configuredChannel,
				checked_version: options.currentVersion,
			};
			if (scopeChanged) {
				delete next.latest_version;
				delete next.apply_failure;
			}
			return next;
		}).catch(() => undefined);
		return { status: "failed", channel, message };
	}
};
