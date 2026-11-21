// Keep unit/integration tests isolated from the developer's live macOS login Keychain
// unless a test explicitly sets CODELIA_AUTH_STORAGE or injects a Keychain backend.
process.env.CODELIA_AUTH_STORAGE ??= "file";
