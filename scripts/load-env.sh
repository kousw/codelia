#!/usr/bin/env bash

# Source a .env file into the current shell with auto-export.
# Usage: source scripts/load-env.sh [path]

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "This script must be sourced: source scripts/load-env.sh [path]" >&2
  exit 1
fi

env_file="${1:-.env}"

if [[ ! -f "${env_file}" ]]; then
  echo "Env file not found: ${env_file}" >&2
  return 1
fi

allexport_state="$(set -o | awk '$1 == "allexport" { print $2 }')"

set -a
# shellcheck source=/dev/null
source "${env_file}"
if [[ "${allexport_state}" != "on" ]]; then
  set +a
fi
