import { useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { useChat } from "./hooks/useChat";
import { useSessions } from "./hooks/useSessions";

export const App = () => {
	const {
		sessions,
		activeSessionId,
		loading,
		create,
		remove,
		select,
		refresh,
	} = useSessions();

	const {
		messages,
		isStreaming,
		streamPhase,
		lastError,
		runStartedAt,
		lastRunDurationMs,
		sendMessage,
		cancel,
		loadHistory,
		clearMessages,
	} = useChat(activeSessionId);

	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);

	useEffect(() => {
		if (activeSessionId) {
			loadHistory(activeSessionId);
		} else {
			clearMessages();
		}
	}, [activeSessionId, loadHistory, clearMessages]);

	const handleSelectSession = (sessionId: string) => {
		select(sessionId);
		setSidebarOpen(false);
	};

	return (
		<div className="az-app">
			<div className="az-backdrop" aria-hidden="true" />
			<div className={`az-shell${sidebarOpen ? " is-sidebar-open" : ""}`}>
				<SessionSidebar
					sessions={sessions}
					activeSessionId={activeSessionId}
					loading={loading}
					onSelect={handleSelectSession}
					onCreate={create}
					onDelete={remove}
					onRefresh={refresh}
					onOpenSettings={() => setSettingsOpen(true)}
					onCloseMobile={() => setSidebarOpen(false)}
				/>
				<div className="az-chat-area">
					<ChatPanel
						messages={messages}
						isStreaming={isStreaming}
						streamPhase={streamPhase}
						lastError={lastError}
						runStartedAt={runStartedAt}
						lastRunDurationMs={lastRunDurationMs}
						onSend={sendMessage}
						onCancel={cancel}
						onClearMessages={clearMessages}
						sessionId={activeSessionId}
						onCreateSession={create}
						onOpenSidebar={() => setSidebarOpen(true)}
					/>
				</div>
				<button
					type="button"
					className={`az-mobile-overlay${sidebarOpen ? " is-open" : ""}`}
					onClick={() => setSidebarOpen(false)}
					aria-label="Close sidebar"
				/>
			</div>
			<SettingsDialog
				isOpen={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
		</div>
	);
};
