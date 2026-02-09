import { cac } from "cac";

export type ParsedArgs = {
	positionals: string[];
	options: Record<string, unknown>;
};

const parseWithCac = (
	values: string[],
): { args: string[]; options: Record<string, unknown> } => {
	const cli = cac("codelia-args");
	cli.command("[...positionals]").allowUnknownOptions();
	const parsed = cli.parse(["node", "codelia-args", ...values], {
		run: false,
	});
	return {
		args: [...parsed.args],
		options: parsed.options as Record<string, unknown>,
	};
};

export const parseBoolean = (value: string, flagName: string): boolean => {
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	throw new Error(`${flagName} must be true|false`);
};

export const parseTimeout = (value: string): number => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error("--request-timeout-ms must be a positive integer");
	}
	return parsed;
};

export const parseEpochMs = (value: string, flagName: string): number => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${flagName} must be a positive integer (epoch ms)`);
	}
	return parsed;
};

export const parseKeyValue = (
	raw: string,
	flagName: string,
): [string, string] => {
	const [key, ...rest] = raw.split("=");
	const value = rest.join("=");
	if (!key || !value) {
		throw new Error(`${flagName} must be key=value`);
	}
	return [key, value];
};

export const parseCliArgs = (values: string[]): ParsedArgs => {
	const parsed = parseWithCac(values);
	return {
		positionals: parsed.args,
		options: parsed.options,
	};
};

const readOptionValues = (parsed: ParsedArgs, flagName: string): string[] => {
	const value = parsed.options[flagName];
	if (value == null || value === false || value === true) return [];
	const entries = Array.isArray(value) ? value : [value];
	return entries.map((entry) => String(entry));
};

export const getLastFlagValue = (
	parsed: ParsedArgs,
	flagName: string,
): string | undefined => {
	const values = readOptionValues(parsed, flagName);
	if (!values || values.length === 0) return undefined;
	return values[values.length - 1];
};

export const getAllFlagValues = (
	parsed: ParsedArgs,
	flagName: string,
): string[] => readOptionValues(parsed, flagName);

export const hasBooleanFlag = (parsed: ParsedArgs, flagName: string): boolean =>
	parsed.options[flagName] === true;
