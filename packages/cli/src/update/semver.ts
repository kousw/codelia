import { isValidUpdateChannel } from "@codelia/config-loader";

export type ParsedSemver = {
	major: number;
	minor: number;
	patch: number;
	prerelease: readonly (number | string)[];
	raw: string;
};

const MAX_VERSION_LENGTH = 128;
const SEMVER_RE =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_ID_RE = /^(0|[1-9]\d*)$/;

export const parseVersion = (value: unknown): ParsedSemver | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return null;
	const match = SEMVER_RE.exec(trimmed);
	if (!match) return null;
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	const patch = Number.parseInt(match[3], 10);
	if (
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!Number.isSafeInteger(patch)
	) {
		return null;
	}
	const prerelease: (number | string)[] = [];
	if (match[4]) {
		for (const part of match[4].split(".")) {
			if (NUMERIC_ID_RE.test(part)) {
				const num = Number.parseInt(part, 10);
				if (!Number.isSafeInteger(num)) return null;
				prerelease.push(num);
			} else if (/^0\d+$/.test(part)) {
				// SemVer forbids leading zeroes in numeric prerelease identifiers.
				return null;
			} else {
				prerelease.push(part);
			}
		}
	}
	return { major, minor, patch, prerelease, raw: trimmed };
};

export const isValidVersion = (value: unknown): value is string =>
	parseVersion(value) !== null;

export const compareVersions = (a: string, b: string): -1 | 0 | 1 | null => {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return null;
	for (const [l, r] of [
		[left.major, right.major],
		[left.minor, right.minor],
		[left.patch, right.patch],
	] as const) {
		if (l !== r) return l > r ? 1 : -1;
	}
	const lp = left.prerelease;
	const rp = right.prerelease;
	if (lp.length === 0 && rp.length === 0) return 0;
	if (lp.length === 0) return 1;
	if (rp.length === 0) return -1;
	const len = Math.min(lp.length, rp.length);
	for (let i = 0; i < len; i += 1) {
		const li = lp[i];
		const ri = rp[i];
		if (li === ri) continue;
		const lNum = typeof li === "number";
		const rNum = typeof ri === "number";
		if (lNum && rNum) return li > ri ? 1 : -1;
		if (lNum !== rNum) return lNum ? -1 : 1;
		return String(li) > String(ri) ? 1 : -1;
	}
	if (lp.length === rp.length) return 0;
	return lp.length > rp.length ? 1 : -1;
};

export const isNewerVersion = (candidate: string, current: string): boolean =>
	compareVersions(candidate, current) === 1;

/**
 * Infer npm dist-tag from the running version when `update.channel` is unset:
 * stable versions follow `latest`; prereleases like `0.2.0-beta.1` follow `beta`.
 */
export const inferChannelFromVersion = (version: string): string => {
	const parsed = parseVersion(version);
	const first = parsed?.prerelease[0];
	if (typeof first === "string" && isValidUpdateChannel(first)) {
		return first;
	}
	return "latest";
};
