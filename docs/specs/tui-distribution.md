# TUI Distribution Spec

This document describes the TUI distribution and startup resolution of `codelia`.
Define it separately into **current implementation (Implemented)** and **target specification (Planned)**.

## 1. Scope

- Target: Path to start Rust TUI (`codelia-tui`) from `@codelia/cli`
- Not covered: UI protocol details, runtime/core internal specifications

## 2. Current Behavior (Implemented)

Basis: `packages/cli/src/tui/launcher.ts` of `resolveTuiCommand()` / `resolveOptionalTuiBinaryPath()` / `runTui()`.

### 2.1 Boot command resolution order

1. Use `CODELIA_TUI_CMD` if it exists
2. Resolve bundled binaries from platform package introduced in `optionalDependencies`
- Supported packages:
     - `@codelia/tui-darwin-arm64`
     - `@codelia/tui-darwin-x64`
     - `@codelia/tui-linux-arm64`
     - `@codelia/tui-linux-x64`
     - `@codelia/tui-win32-x64`
3. Explore the following as a development fallback (with executable bit)
   - `target/release/codelia-tui`
   - `target/debug/codelia-tui`
   - `crates/tui/target/release/codelia-tui`
   - `crates/tui/target/debug/codelia-tui`
4. If none, `codelia-tui` (PATH resolution)

### 2.2 Known operational issues

- Partial: In environments where the platform package has not been installed or released, it will be saved to the development fallback / PATH fallback.
- Partial: In environments where there are inaccessible directories in PATH (e.g. WSL + Windows PATH mixed),
May be `spawn codelia-tui EACCES`.

### 2.3 Overwriting method

- `CODELIA_TUI_CMD`: Completely overwrite startup binary
- `CODELIA_TUI_ARGS`: Inject additional arguments to TUI

## 3. Packaging Layout

### 3.1 Implemented

- `@codelia/cli`: Entry point (`codelia`) and startup logic
- `@codelia/tui-<platform>-<arch>`: Only Rust TUI binaries by OS/arch
- Example: `@codelia/tui-linux-x64`, `@codelia/tui-darwin-arm64`
- Package placement: `packages/tui/<platform-arch>/`

### 3.2 Implemented

- Enumerate platform packages in `optionalDependencies` of `@codelia/cli`
- Do not use `postinstall` copy, resolve `package.json` of the corresponding package with `process.platform` / `process.arch` at runtime,
Directly target `<package>/bin/codelia-tui` (`.exe` on Windows).
- Each platform package checks the existence of binary in `bin/` in `prepack`.

### 3.3 Planned

- Incorporate SHA256 verification and signature verification flows into CI/release.
- PATH fallback will remain for the time being to maintain compatibility. Eventually it will be removed or made an opt-in.

## 4. Failure Handling

### 4.1 Implemented

- `spawn` Display the failure reason on error,
Guide the use of `CODELIA_TUI_CMD/CODELIA_TUI_ARGS`.
- For `ENOENT`, include the target platform package name (e.g. `@codelia/tui-linux-x64`) in the error statement.

### 4.2 Planned

- More detailed diagnosis when PATH fallback fails (`ENOENT`/`EACCES`).

## 5. CI / Release

### 5.1 Implemented

1. Place the binary in `bin/` of the target package with `scripts/stage-tui-binary.mjs`.
2. Execute `npm pack -> npm install -> node .../cli/dist/index.cjs mcp list` on `scripts/release-smoke.mjs`.
3. Run smoke on Linux/macOS/Windows matrix with GitHub Actions `release-smoke.yml`.

### 5.2 Planned

- Automated publishing of each `@codelia/tui-*` package (including version consistency).
- Verify checksum/signature of release artifacts in publish pipeline.

## 7. Status Table

- Implemented: `CODELIA_TUI_CMD` override, platform package resolution, development fallback, PATH fallback, release smoke
- Partial: PATH fallback diagnostic granularity is limited
- Planned: checksum/signature verification, reduced PATH fallback dependence
