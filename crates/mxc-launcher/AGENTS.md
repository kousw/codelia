# Native MXC launcher

The macOS arm64 launcher runs an admitted command with the official MXC Rust SDK and the Seatbelt profile supplied by runtime. The same binary contains the supervisor and worker. Runtime owns tool admission, resource policy, trusted binary discovery and task accounting. [Runtime integration](../../packages/runtime/src/permissions/mxc-launcher.ts) · [Architecture and qualification](../../dev-docs/specs/command-approval-reference.ja.md#mxc-evaluation)

The payload receives standard input, output and error. A separate private channel carries the request and lifecycle reports. Report a verified completion only after SDK cleanup and the matching terminal report. Workload exit codes, including 125, are data. Missing reports and cleanup warnings mean the outcome is unconfirmed. All signals outside the SDK must target a process or group owned by the invocation.

Run `cargo test --locked --manifest-path crates/mxc-launcher/Cargo.toml` for the portable protocol tests. On a macOS arm64 host, build the release helper and run the runtime native tests with `CODELIA_APPROVAL_MXC_LIVE=1`. The packed install smoke exercises local and SDK selection in a workspace separate from the installation. Linux and Windows currently build the protocol checks and return 125 for an unsupported helper invocation.
Use host-native absolute paths in protocol fixtures. The decoder uses `Path::is_absolute()`, which requires a drive prefix for rooted Windows drive paths.
