#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/setup-codelia-dev-alias.sh [--file <rc-file>] [--alias <name>]

Options:
  --file <rc-file>  Shell rc file to update (default: auto-detect from $SHELL)
  --alias <name>    Alias name to create (default: codelia-dev)
  -h, --help        Show this help
EOF
}

alias_name="codelia-dev"
rc_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      rc_file="${2:-}"
      shift 2
      ;;
    --alias)
      alias_name="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${alias_name}" ]]; then
  echo "--alias must not be empty." >&2
  exit 1
fi

if [[ -z "${rc_file}" ]]; then
  shell_name="$(basename "${SHELL:-}")"
  case "${shell_name}" in
    bash)
      rc_file="${HOME}/.bashrc"
      ;;
    zsh)
      rc_file="${HOME}/.zshrc"
      ;;
    *)
      echo "Could not auto-detect rc file for shell: ${shell_name:-unknown}" >&2
      echo "Pass --file <rc-file> explicitly." >&2
      exit 1
      ;;
  esac
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cli_entry="${repo_root}/packages/cli/dist/index.cjs"

if [[ ! -f "${cli_entry}" ]]; then
  echo "Warning: ${cli_entry} does not exist yet." >&2
  echo "Run 'bun run build' before using the alias." >&2
fi

mkdir -p "$(dirname "${rc_file}")"
touch "${rc_file}"

block_start="# >>> codelia-dev alias >>>"
block_end="# <<< codelia-dev alias <<<"

tmp_file="$(mktemp)"
cleanup() {
  rm -f "${tmp_file}"
}
trap cleanup EXIT

awk -v start="${block_start}" -v end="${block_end}" '
  $0 == start { in_block = 1; next }
  $0 == end { in_block = 0; next }
  !in_block { print }
' "${rc_file}" > "${tmp_file}"

{
  echo "${block_start}"
  echo "# Added by scripts/setup-codelia-dev-alias.sh"
  printf "alias %s='CODELIA_LANE_LAUNCH_COMMAND=\"node \\\"%s\\\"\" node \\\"%s\\\"'\n" "${alias_name}" "${cli_entry}" "${cli_entry}"
  echo "${block_end}"
} >> "${tmp_file}"

mv "${tmp_file}" "${rc_file}"

echo "Updated ${rc_file}"
echo "Alias: ${alias_name} -> CODELIA_LANE_LAUNCH_COMMAND=\"node \\\"${cli_entry}\\\"\" node \"${cli_entry}\""
echo "Run: source \"${rc_file}\""
