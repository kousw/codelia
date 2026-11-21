// Live Keychain coverage constructs its own client behind CODELIA_TEST_LIVE_KEYCHAIN=1.
process.env.CODELIA_AUTH_STORAGE = "file";
// Logout and recovery can still inspect Keychain in file mode. Require an
// explicit fixture or opt-in helper for any subprocess launched by tests.
process.env.CODELIA_TEST_KEYCHAIN_DISABLED = "1";
