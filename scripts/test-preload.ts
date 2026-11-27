// Loaded by bunfig.toml. Runtime processes started by tests inherit it.

// Outgoing protocol messages are checked against the catalog schemas.
// See dev-docs/specs/protocol-codegen.md section 8.
process.env.CODELIA_TEST_PROTOCOL_ASSERT ??= "1";

// Live Keychain coverage constructs its own client behind CODELIA_TEST_LIVE_KEYCHAIN=1.
process.env.CODELIA_AUTH_STORAGE = "file";
// Logout and recovery can still inspect Keychain in file mode. Require an
// explicit fixture or opt-in helper for any subprocess launched by tests.
process.env.CODELIA_TEST_KEYCHAIN_DISABLED = "1";
