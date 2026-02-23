#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
usage: tools/terminal-bench/scripts/run-harbor.sh -- [harbor run args]

example (custom codelia agent import):
  tools/terminal-bench/scripts/run-harbor.sh -- \
    -d terminal-bench@2.0 \
    --agent-import-path tools.terminal_bench_python_adapter.codelia_agent:CodeliaInstalledAgent \
    --model openai/gpt-5.3-codex \
    --ak approval_mode=full-access \
    --ak auth_file=$HOME/.codelia/auth.json

notes:
  - This wrapper delegates scoring to Harbor.
  - Pass Harbor CLI arguments after `--` unchanged.
  - Optional env: HARBOR_CMD (default: harbor)
USAGE
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"

cd "${ROOT_DIR}"

HARBOR_CMD="${HARBOR_CMD:-harbor}"
if ! command -v "${HARBOR_CMD}" >/dev/null 2>&1; then
  echo "harbor command not found: ${HARBOR_CMD}" >&2
  exit 2
fi

args=("$@")
if [[ "${args[0]}" == "--" ]]; then
  args=("${args[@]:1}")
fi

if [[ ${#args[@]} -eq 0 ]]; then
  echo "missing harbor run args (pass after --)" >&2
  exit 2
fi

if [[ "${args[0]}" == "run" ]]; then
  harbor_args=("${args[@]}")
else
  harbor_args=(run "${args[@]}")
fi

log_dir="tmp/terminal-bench/harbor"
mkdir -p "${log_dir}"
log_file="${log_dir}/harbor-$(date -u +%Y%m%dT%H%M%SZ).log"

echo "[terminal-bench] harbor cmd: ${HARBOR_CMD} ${harbor_args[*]}" >&2
echo "[terminal-bench] harbor log: ${log_file}" >&2

set +e
"${HARBOR_CMD}" "${harbor_args[@]}" 2>&1 | tee "${log_file}"
status=${PIPESTATUS[0]}
set -e

latest_job_dir="$(ls -dt jobs/* 2>/dev/null | head -n 1 || true)"
if [[ -n "${latest_job_dir}" ]]; then
  echo "[terminal-bench] latest job dir: ${latest_job_dir}" >&2
fi

score_line="$(grep -E -i "(final[[:space:]_-]*)?score[[:space:]]*[:=]" "${log_file}" | tail -n 1 || true)"
if [[ -n "${score_line}" ]]; then
  echo "[terminal-bench] detected score line: ${score_line}" >&2
else
  echo "[terminal-bench] no explicit score line detected in harbor output." >&2
  echo "[terminal-bench] check Harbor summary/report for official score." >&2
fi

exit "${status}"
