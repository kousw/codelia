import { randomUUID } from "node:crypto";
import type {
	ApprovalChoice,
	ApprovalRequest,
	Confirmation,
	InteractiveShellConfirmation,
	ProposedShellAllowance,
} from "./dispatch";

export const awaitAbortable = <T>(
	signal: AbortSignal,
	action: () => Promise<T>,
): Promise<T | undefined> =>
	new Promise((resolve, rejectPromise) => {
		if (signal.aborted) {
			resolve(undefined);
			return;
		}
		const abort = () => resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => (signal.aborted ? undefined : action()))
			.then(resolve, rejectPromise)
			.finally(() => signal.removeEventListener("abort", abort));
	});

/** User choices are the only transitions that can request or accept a future allowance. */
export async function selectShellAllowance({
	request,
	propose,
	ask,
	checkCurrent,
	signal,
}: {
	request: ApprovalRequest;
	propose?: InteractiveShellConfirmation["propose"];
	ask: (
		id: string,
		choices: ApprovalChoice[],
		details: Pick<Confirmation, "shellStage" | "saveDescription">,
	) => Promise<ApprovalChoice>;
	checkCurrent: () => void;
	signal?: AbortSignal;
}): Promise<{ choice: ApprovalChoice; proposal?: ProposedShellAllowance }> {
	const choice = await ask(
		request.id,
		propose
			? ["allow_once", "setup_allowance", "deny_continue"]
			: ["allow_once", "deny_continue"],
		{ shellStage: "initial" },
	);
	if (choice !== "setup_allowance" || !propose) return { choice };

	checkCurrent();
	const proposalSignal = signal ?? new AbortController().signal;
	let proposal: ProposedShellAllowance | undefined;
	try {
		proposal = await awaitAbortable(proposalSignal, () =>
			propose(request, proposalSignal),
		);
	} catch {
		// The user can still decide this single launch when no suggestion is available.
	}
	checkCurrent();
	const finalChoice = await ask(
		randomUUID(),
		proposal
			? ["allow_once", "save_session", "save_project", "deny_continue"]
			: ["allow_once", "deny_continue"],
		{
			shellStage: proposal ? "rule" : "unavailable",
			saveDescription: proposal?.description,
		},
	);
	return { choice: finalChoice, proposal };
}
