# scripts

## Notes
- scripts/load-env.sh is a source-only helper to export variables from a .env file into the current shell: `source scripts/load-env.sh [path]`.
- scripts/setup-codelia-dev-alias.sh writes a managed alias block (default: `codelia-dev`) into `.bashrc`/`.zshrc` or a custom rc file.
- scripts/bump-workspace-version.mjs bumps all package versions under `packages/`, syncs workspace internal dependency versions, and updates `crates/tui/Cargo.toml` in one shot.
- scripts/release-workspace.mjs automates `bump:version` + `check:versions` + release commit + optional push (`--no-push`, `--allow-dirty`) and includes `crates/tui/Cargo.toml` in staged release-version changes.
- release-smoke.mjs includes the logger package in its tarball list so npm install doesn't fall back to the registry.
- release-smoke.mjs runs npm.cmd via a Windows shell to avoid spawnSync EINVAL on Windows runners.
