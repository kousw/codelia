# scripts

## Notes
- scripts/load-env.sh is a source-only helper to export variables from a .env file into the current shell: `source scripts/load-env.sh [path]`.
- release-smoke.mjs includes the logger package in its tarball list so npm install doesn't fall back to the registry.
- release-smoke.mjs runs npm.cmd via a Windows shell to avoid spawnSync EINVAL on Windows runners.
