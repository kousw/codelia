#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/setup-worktree.sh

Runs `bun install` at the current repository root.
Useful right after creating or switching into a git worktree.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

if [[ ! -f "${repo_root}/package.json" ]]; then
  echo "Could not find package.json at repo root: ${repo_root}" >&2
  exit 1
fi

echo "Running bun install in ${repo_root}"
cd "${repo_root}"
bun install
