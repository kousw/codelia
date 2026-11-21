/** Frozen before sending. Resolution must use the same destination and condition. */
export type BrokeredMutation = Readonly<{
	requestId: string;
	destination: string;
	operation: string;
	target: string;
	value: string;
	expectedValue: string | null;
}>;

export type BrokeredMutationOutcome = "applied" | "rejected" | "unknown";

export type BrokeredMutationAdapter = {
	update: (
		request: BrokeredMutation,
		signal?: AbortSignal,
	) => Promise<BrokeredMutationOutcome>;
	observe: (
		request: BrokeredMutation,
		signal?: AbortSignal,
	) => Promise<BrokeredMutationOutcome>;
};

/**
 * Run after approval, using a trusted transport for one conditional update.
 * If acknowledgement is lost, the observation is read-only and cannot replay
 * the update. Cancellation after dispatch can leave an unknown result.
 */
export const runBrokeredMutation = async (
	request: BrokeredMutation,
	adapter: BrokeredMutationAdapter,
	signal?: AbortSignal,
): Promise<BrokeredMutationOutcome> => {
	signal?.throwIfAborted();
	const frozen = Object.freeze({ ...request });
	let outcome: BrokeredMutationOutcome;
	try {
		outcome = await adapter.update(frozen, signal);
	} catch {
		outcome = "unknown";
	}
	if (outcome === "applied" || outcome === "rejected") return outcome;
	if (signal?.aborted) return "unknown";
	try {
		const observed = await adapter.observe(frozen, signal);
		return observed === "applied" || observed === "rejected"
			? observed
			: "unknown";
	} catch {
		return "unknown";
	}
};
