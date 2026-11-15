import {
	cleanupRunLogs,
	resolveStoragePaths,
	SessionStateStoreImpl,
} from "@codelia/storage";

const HELP =
	"usage: codelia session list | pin|unpin|archive|unarchive <session_id> | cleanup\nArchive compresses unpinned run events. Original messages, active context and reference data remain; diagnostic dumps may expire.";

export async function runSessionCommand(args: string[]): Promise<number> {
	const [action, sessionId, extra] = args;
	if (!action || action === "--help" || action === "help") {
		console.log(HELP);
		return 0;
	}
	if (
		action === "list" || action === "cleanup"
			? sessionId !== undefined
			: !["pin", "unpin", "archive", "unarchive"].includes(action) ||
				!sessionId ||
				extra !== undefined ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)
	) {
		console.error(HELP);
		return 1;
	}
	const paths = resolveStoragePaths();
	const sessions = new SessionStateStoreImpl({ paths });
	try {
		if (action === "list") {
			for (const session of (await sessions.list()).sort((a, b) =>
				b.updated_at.localeCompare(a.updated_at),
			))
				console.log(
					`${session.session_id}\t${session.updated_at}\t${session.pinned ? "pinned" : "unpinned"}\t${session.archived_at ? "archived" : "active"}`,
				);
			return 0;
		}
		if (action === "cleanup") {
			console.log(JSON.stringify(await cleanupRunLogs({ paths, sessions })));
			return 0;
		}
		if (!sessionId) return 1;
		const patch =
			action === "pin" || action === "unpin"
				? { pinned: action === "pin" }
				: { archived: action === "archive" };
		const session = await sessions.updateMetadata(sessionId, patch);
		console.log(JSON.stringify(session));
		if (!session.pinned && action !== "unarchive")
			console.log(
				JSON.stringify(await cleanupRunLogs({ paths, sessions, sessionId })),
			);
		return 0;
	} catch (error) {
		console.error(
			`Session command failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}
