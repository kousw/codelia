# Native credential helper

The macOS helper stores and retrieves Codelia's serialized JSON credential payloads (`codelia.auth` and `codelia.mcp-auth`) directly via Apple's `Security.framework` (`SecItemCopyMatching`, `SecItemAdd`, `SecItemUpdate`, `SecItemDelete`, and `SecKeychainGetStatus`).

- All requests and responses pass strictly over private stdin/stdout UTF-8 JSON pipes (never CLI argv or env vars), avoiding `/usr/bin/security -i`'s 4,096-byte interactive buffer limit.
- Before any Keychain operation, the helper checks `SecKeychainGetStatus` (`kSecUnlockStateStatus`) and returns `code: "locked"` when the login Keychain is locked so SSH/headless callers fail cleanly without spawning a macOS UI prompt.
- Non-macOS targets compile portable protocol checks and return `code: "unavailable"`.
- Run `cargo test --locked --manifest-path crates/credential-helper/Cargo.toml` for portable protocol tests, and `bun run credential-helper:build` on macOS to build the release binary.
