export const ConversationRunningIndicator = () => {
	return (
		<article className="message-row assistant-status-row" aria-live="polite">
			<div className="assistant-pending">
				<span className="assistant-pending-dots" aria-hidden="true">
					<span />
					<span />
					<span />
				</span>
				<span>Running</span>
			</div>
		</article>
	);
};
