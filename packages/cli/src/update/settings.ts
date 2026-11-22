import { promises as fs } from "node:fs";
import {
	isValidUpdateChannel,
	parseUpdateMode,
	type UpdateMode,
} from "@codelia/config-loader";

export type ResolvedUpdateSettings = {
	mode: UpdateMode;
	/** Explicit npm dist-tag override; null means infer from the running version. */
	channel: string | null;
	warnings: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCiEnvironment = (env: NodeJS.ProcessEnv): boolean => {
	const ci = (env.CI ?? "").trim().toLowerCase();
	if (ci === "1" || ci === "true" || ci === "yes") return true;
	return Boolean(
		env.GITHUB_ACTIONS ||
			env.GITLAB_CI ||
			env.BUILDKITE ||
			env.CIRCLECI ||
			env.JENKINS_URL,
	);
};

const parseEnvMode = (
	raw: string | undefined,
): { value?: UpdateMode; invalid?: boolean } => {
	if (raw === undefined) return {};
	const normalized = raw.trim().toLowerCase();
	if (normalized === "") return {};
	if (normalized === "0" || normalized === "false" || normalized === "off") {
		return { value: "off" };
	}
	if (normalized === "1" || normalized === "true" || normalized === "auto") {
		return { value: "auto" };
	}
	if (normalized === "notify") {
		return { value: "notify" };
	}
	return { invalid: true };
};

const readGlobalUpdateConfig = async (
	configFile: string,
): Promise<{
	mode?: UpdateMode;
	channel?: string;
	warnings: string[];
}> => {
	const warnings: string[] = [];
	let rawText: string;
	try {
		rawText = await fs.readFile(configFile, "utf8");
	} catch {
		return { warnings };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch {
		return { warnings };
	}
	if (!isRecord(parsed) || !isRecord(parsed.update)) {
		return { warnings };
	}
	const update = parsed.update;
	let mode: UpdateMode | undefined;
	if (update.mode !== undefined) {
		mode = parseUpdateMode(update.mode);
		if (!mode) {
			warnings.push(
				`Ignoring invalid update.mode in ${configFile} (expected "auto", "notify", or "off").`,
			);
		}
	}
	let channel: string | undefined;
	if (update.channel !== undefined) {
		if (
			typeof update.channel === "string" &&
			isValidUpdateChannel(update.channel)
		) {
			channel = update.channel;
		} else {
			warnings.push(
				`Ignoring invalid update.channel in ${configFile} (expected an npm dist-tag name).`,
			);
		}
	}
	return { mode, channel, warnings };
};

export type ResolveUpdateSettingsOptions = {
	env?: NodeJS.ProcessEnv;
	interactive: boolean;
	configFile: string;
};

/**
 * Self-update settings come exclusively from the user's global `config.json`
 * and environment variables — project-local configs can never redirect updates.
 */
export const resolveUpdateSettings = async (
	options: ResolveUpdateSettingsOptions,
): Promise<ResolvedUpdateSettings> => {
	const env = options.env ?? process.env;
	const fromConfig = await readGlobalUpdateConfig(options.configFile);
	const warnings = [...fromConfig.warnings];

	const envMode = parseEnvMode(env.CODELIA_AUTO_UPDATE);
	if (envMode.invalid) {
		warnings.push(
			`Ignoring invalid CODELIA_AUTO_UPDATE=${env.CODELIA_AUTO_UPDATE} (expected "auto", "notify", or "off").`,
		);
	}

	let channel: string | null = fromConfig.channel ?? null;
	if (env.CODELIA_UPDATE_CHANNEL !== undefined) {
		const trimmed = env.CODELIA_UPDATE_CHANNEL.trim();
		if (trimmed.length === 0) {
			channel = null;
		} else if (isValidUpdateChannel(trimmed)) {
			channel = trimmed;
		} else {
			warnings.push(
				`Ignoring invalid CODELIA_UPDATE_CHANNEL=${env.CODELIA_UPDATE_CHANNEL}.`,
			);
		}
	}

	let mode: UpdateMode = envMode.value ?? fromConfig.mode ?? "notify";
	if (!options.interactive || isCiEnvironment(env)) {
		// Never run automatic background checks or installs in CI or non-interactive runs.
		mode = "off";
	}
	return { mode, channel, warnings };
};
