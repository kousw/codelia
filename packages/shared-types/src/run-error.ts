import type { ProviderName } from "./provider";

/** Safe failure-only context for status notifications and retained errors. */
export type RunErrorInfo = {
	name: string;
	message: string;
	provider?: ProviderName;
	kind?: string;
	status?: number;
	code?: string;
	attempts?: number;
	max_attempts?: number;
	detail?: string;
	hint?: string;
};
