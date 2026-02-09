export type AuthLogoutParams = {
	clear_session?: boolean;
};

export type AuthLogoutResult = {
	ok: boolean;
	auth_cleared: boolean;
	session_cleared: boolean;
	cancelled?: boolean;
};
