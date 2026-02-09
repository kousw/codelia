export type SessionStateSummary = {
	session_id: string;
	updated_at: string;
	run_id?: string;
	message_count?: number;
	last_user_message?: string;
};
