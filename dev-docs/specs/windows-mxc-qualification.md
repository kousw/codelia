# Windows ProcessContainer qualification

**Evaluation only.** Codelia has no qualified Windows configuration enabled by default. This probe measures the official MXC SDK 1.1.0 and stable V1 contract 1.0.0 on one host. Running it does not change Codelia settings. [SDK release](https://github.com/microsoft/mxc/releases/tag/v1.1.0) · [V1 types](https://github.com/microsoft/mxc/blob/v1.1.0/sdk/node/src/v1/types.ts)

## Run the probe

Use an updated Windows 11 x64 or arm64 host, a user-private temporary directory on NTFS, official Node.js 24.22.1 and npm. Record the exact Windows build, update revision and capabilities for the request. Process Isolation was introduced in builds including 24H2 26100.9278 and 25H2 26200.9278. [Supported OS versions](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/process-container/os-version-support.md)

Run as the intended standard user. Install the exact SDK into a dedicated directory and clear native-library override variables. The probe compares the DLL SHA-256 with the official npm distribution. Run where required host diagnostics are permitted. Optional diagnostics are disabled for the call. Required host diagnostics can use an OS collection path independent of worker networking. Transmission itself has not been measured. [Microsoft diagnostics contract](https://github.com/microsoft/mxc/blob/v1.1.0/docs/telemetry.md)

From the repository root in PowerShell:

```powershell
$sdk = Join-Path $env:TEMP ("codelia-mxc-sdk-" + [guid]::NewGuid())
npm install --prefix $sdk --save-exact --no-audit --no-fund @microsoft/mxc-sdk@1.1.0
if ($LASTEXITCODE -ne 0) { throw "MXC SDK install failed" }
node scripts/qualify-windows-mxc.mjs $sdk | Set-Content -Encoding utf8 windows-mxc-observation.json
$LASTEXITCODE
```

To measure outbound reachability, set `CODELIA_TEST_QUALIFICATION_PEER` to the IPv4 address and port of a TCP listener on another host you control (`IP:PORT`). The worker attempts only a TCP connection. With the variable unset, outbound reachability is recorded as `untested`; the default targets are synthetic loopback and a temporary named pipe. The probe removes its file and ACL fixtures and closes the listener. The SDK installation and observation JSON remain. The manual **Windows MXC qualification** workflow records separate observations for Windows 11 ARM and Windows Server 2025 x64.

## Reading an observation

| Check | Evidence and expected result |
| --- | --- |
| Distribution and OS | Node/OS versions, update revision, CPU, Node and SDK DLL hashes, and contract version. Published records omit local paths, command environment values and stderr. |
| Request-specific probe | Require `tier=base-container`, `baseContainerApiPresent=true`, `baseContainerSupportsDenyPaths=true` and `needsDaclAugmentation=false`. Execute the same request that was probed. [Probe implementation](https://github.com/microsoft/mxc/blob/v1.1.0/sdk/node/src/v1/probe.ts) |
| Files | Both profiles read workspace and reference fixtures and write private scratch. Development may write the workspace. Require access denied for investigation writes there, writes to the reference fixture, and reads or writes under an explicitly denied directory. |
| Existing ACLs | Give `ALL_APPLICATION_PACKAGES` modify access to a fixture outside the added paths and record actual reads and writes. Existing grants and named IPC access depend on the host. [Filesystem contract](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/process-container/filesystem.md) |
| Network and IPC | Request deny for egress, ingress and host loopback. Check that a host-reachable TCP listener is unreachable from the worker, using host controls before and after. Record the observed synthetic pipe result. Do not inherit forward-proxy or LAN settings. [Network contract](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/process-container/networking.md) |
| Launch and cancellation | Use an absolute Node executable and verify cwd and argv containing spaces, empty strings, quotes, trailing backslashes and Unicode. Check that host-only environment variables do not reach the worker. Observe a descendant PID, kill and wait on the parent's SDK handle, and verify descendant termination. |

`observed_subset_passed` exits zero when the required checks in this subset pass. `failed` means an expectation failed; `inconclusive` means a prerequisite such as the DLL, probe, launch or positive control failed; `unavailable` means the host is not Windows. All three exit nonzero. Local checks on 2026-11-19 covered official package types, request construction, an unconfined positive control and the non-Windows exit.

**Hosted observations, 2026-11-19.** Windows Server 2025 x64 stopped before launch because required native capabilities were absent. On Windows 11 ARM 26200.9974 the SDK reported base-container support and deny paths without ACL augmentation. A minimal ARM64 console executable exited with the expected code 42 both on the host and in confinement. Node 24.22.1 exited with `0xC0000142` (DLL initialization failed) and zero output for both `--version` and the worker. The failing DLL or missing permission is unknown. Filesystem, networking and descendant cleanup through the product runtime still need qualification. [Server observation](https://github.com/kousw/codelia/actions/runs/44389709176) · [ARM comparison](https://github.com/kousw/codelia/actions/runs/44391629882)

Before enabling a configuration, add the following evidence on the same OS revision, SDK, CPU and Node combination:

- Verify every granted path, protected aliases and junctions, cross-volume and same-file identity, and ACLs before and after execution. Show residual ACL and IPC access to the operator.
- Measure inbound access from a controlled peer, IPv6 and UDP, loopback in both directions, handles and individual named IPC endpoints. Record any untested directions and targets.
- Exercise the shipped Node/Bun entry point, PowerShell or cmd argv and stdio, and descendant cleanup after normal exit, timeout and host disconnect using Codelia's process lifecycle.

## Comparison with Codex

OpenAI's November 18 description uses the Rust SDK and disables a fallback that modifies host ACLs. In the pinned Microsoft SDK, the compatibility field `fallback.allowDaclMutation` is accepted but ignored and cannot enable host DACL mutation. Existing ACLs still apply. The article does not identify the precise binary used. Its drive-wide read grant, PowerShell registry/desktop/Win32k access and proxy loopback reflect its own profile. Codelia's fixture exercises Node and synthetic directories with UI disabled and host loopback denied. PowerShell and drive-wide access require separate Windows measurements. [Codex sandbox](https://openai.com/index/inside-the-codex-sandbox/) · [Stable schema](https://github.com/microsoft/mxc/blob/v1.1.0/docs/schema.md#L325-L330) · [Filesystem contract](https://github.com/microsoft/mxc/blob/v1.1.0/docs/backends/process-container/filesystem.md)
