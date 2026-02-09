import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "../../shared/types";
import { createSession, deleteSession, fetchSessions } from "../api";

export const useSessions = () => {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const list = await fetchSessions();
			setSessions(list);
			setActiveSessionId((prev) => {
				if (prev && list.some((item) => item.session_id === prev)) {
					return prev;
				}
				return list[0]?.session_id ?? prev ?? null;
			});
		} catch {
			// ignore fetch errors in sample app
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const create = useCallback(async () => {
		const sessionId = await createSession();
		setActiveSessionId(sessionId);
		await refresh();
		return sessionId;
	}, [refresh]);

	const remove = useCallback(
		async (sessionId: string) => {
			await deleteSession(sessionId);
			setActiveSessionId((prev) => (prev === sessionId ? null : prev));
			await refresh();
		},
		[refresh],
	);

	const select = useCallback((sessionId: string) => {
		setActiveSessionId(sessionId);
	}, []);

	return {
		sessions,
		activeSessionId,
		loading,
		create,
		remove,
		select,
		refresh,
	};
};
