import { useMemo, useState } from "react";
import type { SessionSummary } from "../../shared/types";

type Props = {
	sessions: SessionSummary[];
	activeSessionId: string | null;
	loading: boolean;
	onSelect: (id: string) => void;
	onCreate: () => void;
	onDelete: (id: string) => void;
	onRefresh: () => Promise<void>;
	onOpenSettings: () => void;
	onCloseMobile: () => void;
};

const formatTime = (iso: string): string => {
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
};

const previewLabel = (session: SessionSummary): string => {
	if (session.last_user_message?.trim()) {
		return session.last_user_message.slice(0, 64);
	}
	return `Session ${session.session_id}`;
};

export const SessionSidebar = ({
	sessions,
	activeSessionId,
	loading,
	onSelect,
	onCreate,
	onDelete,
	onRefresh,
	onOpenSettings,
	onCloseMobile,
}: Props) => {
	const [query, setQuery] = useState("");
	const [isRefreshing, setIsRefreshing] = useState(false);

	const filteredSessions = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		if (!keyword) return sessions;
		return sessions.filter((session) => {
			const text =
				`${session.session_id} ${session.last_user_message ?? ""}`.toLowerCase();
			return text.includes(keyword);
		});
	}, [sessions, query]);

	const handleRefresh = async () => {
		setIsRefreshing(true);
		try {
			await onRefresh();
		} finally {
			setIsRefreshing(false);
		}
	};

	return (
		<aside className="az-sidebar">
			<div className="az-sidebar-head">
				<div className="az-title-wrap">
					<p className="az-overline">Codelia</p>
					<h1 className="az-sidebar-title">Session Dock</h1>
				</div>
				<div className="az-sidebar-actions">
					<button
						type="button"
						className="az-btn az-btn-muted"
						onClick={handleRefresh}
						disabled={isRefreshing}
					>
						{isRefreshing ? "Refreshing" : "Refresh"}
					</button>
					<button
						type="button"
						className="az-btn az-btn-solid"
						onClick={onCreate}
					>
						New
					</button>
					<button
						type="button"
						className="az-btn az-btn-muted"
						onClick={onOpenSettings}
					>
						Settings
					</button>
					<button
						type="button"
						className="az-sidebar-close"
						onClick={onCloseMobile}
						aria-label="Close session panel"
					>
						Close
					</button>
				</div>
			</div>

			<div className="az-sidebar-toolbar">
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search sessions"
					className="az-search"
				/>
				<div className="az-sidebar-summary">
					<span>{filteredSessions.length} visible</span>
					<span>{sessions.length} total</span>
				</div>
			</div>

			<ul className="az-sidebar-list">
				{loading && sessions.length === 0 ? (
					<li className="az-muted-box">Loading sessions...</li>
				) : null}

				{!loading && filteredSessions.length === 0 ? (
					<li className="az-muted-box">
						{query.trim()
							? "No sessions match your search."
							: "No active sessions yet."}
					</li>
				) : null}

				{filteredSessions.map((session) => {
					const isActive = session.session_id === activeSessionId;
					return (
						<li
							key={session.session_id}
							className={`az-session-card${isActive ? " is-active" : ""}`}
						>
							<button
								type="button"
								className="az-session-main"
								onClick={() => onSelect(session.session_id)}
							>
								<div className="az-session-label">{previewLabel(session)}</div>
								<div className="az-session-meta">
									<span>{formatTime(session.updated_at)}</span>
									{session.message_count !== undefined ? (
										<span>{session.message_count} msgs</span>
									) : null}
								</div>
							</button>
							<button
								type="button"
								className="az-icon-btn"
								onClick={() => onDelete(session.session_id)}
								title="Delete session"
								aria-label="Delete session"
							>
								Delete
							</button>
						</li>
					);
				})}
			</ul>
		</aside>
	);
};
