#!/bin/sh
set -eu
codelia_repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec bun "$codelia_repo/scripts/desktop-app.mjs" "$@"
