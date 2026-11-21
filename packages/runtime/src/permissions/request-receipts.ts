import { createHash } from "node:crypto";

export type ApprovalReceiptScope = Readonly<{
	generation: number;
	connectionSignal: AbortSignal;
	ownerSignal: AbortSignal;
}>;

export const assertReceiptScopeCurrent = (
	scope: ApprovalReceiptScope,
): void => {
	if (scope.connectionSignal.aborted || scope.ownerSignal.aborted)
		throw new Error("approval_expired");
};

type Receipt = { binding: string; ownerEpoch: number };

/**
 * Coalesce in-flight retransmissions by the current owner. Once completed,
 * keep only an ID/binding tombstone until the connection ends.
 */
export class ApprovalRequestReceipts<T> {
	private readonly used = new Map<string, Receipt>();
	private readonly pending = new Map<string, Promise<T>>();
	private connection?: AbortSignal;
	private owner?: AbortSignal;
	private ownerEpoch = 0;
	private readonly standaloneScope: ApprovalReceiptScope = {
		generation: 0,
		connectionSignal: new AbortController().signal,
		ownerSignal: new AbortController().signal,
	};

	constructor(
		private readonly pendingLimit = 256,
		private readonly connectionLimit = 32768,
	) {}

	async run<Result extends T>(
		scope: ApprovalReceiptScope | undefined,
		id: string,
		binding: string,
		start: () => Result | Promise<Result>,
	): Promise<Result> {
		scope ??= this.standaloneScope;
		assertReceiptScopeCurrent(scope);
		const { connectionSignal, ownerSignal } = scope;
		if (this.connection !== connectionSignal) {
			this.used.clear();
			this.connection = connectionSignal;
			connectionSignal.addEventListener(
				"abort",
				() => {
					if (this.connection === connectionSignal) this.used.clear();
				},
				{ once: true },
			);
		}
		if (this.owner !== ownerSignal) {
			this.pending.clear();
			this.owner = ownerSignal;
			this.ownerEpoch++;
			ownerSignal.addEventListener(
				"abort",
				() => {
					if (this.owner === ownerSignal) this.pending.clear();
				},
				{ once: true },
			);
		}

		const key = createHash("sha256").update(id).digest("base64url");
		const previous = this.used.get(key);
		if (previous) {
			if (
				previous.ownerEpoch === this.ownerEpoch &&
				previous.binding !== binding
			)
				throw new Error("request_binding_mismatch");
			const existing = this.pending.get(key);
			if (!existing || previous.ownerEpoch !== this.ownerEpoch)
				throw new Error("approval_receipt_expired");
			try {
				return (await existing) as Result;
			} finally {
				assertReceiptScopeCurrent(scope);
			}
		}
		if (
			this.used.size >= this.connectionLimit ||
			this.pending.size >= this.pendingLimit
		)
			throw new Error("approval_receipt_capacity");
		this.used.set(key, { binding, ownerEpoch: this.ownerEpoch });
		const result = Promise.resolve().then(() => {
			assertReceiptScopeCurrent(scope);
			return start();
		});
		this.pending.set(key, result);
		try {
			return await result;
		} finally {
			if (this.pending.get(key) === result) this.pending.delete(key);
			assertReceiptScopeCurrent(scope);
		}
	}
}
