export type AuthLogoutParams = {
	/** Omitted clears all providers; a name clears only that provider. */
	provider?: string;
	clear_session?: boolean;
};

export type AuthLogoutResult = {
	ok: boolean;
	auth_cleared: boolean;
	session_cleared: boolean;
	cancelled?: boolean;
	provider?: string;
};
