#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: tools/terminal-bench/scripts/run-local.sh --prompt \"...\" [options]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"

cd "${ROOT_DIR}"

node "${ROOT_DIR}/tools/terminal-bench/scripts/run-benchmark.mjs" "$@"
