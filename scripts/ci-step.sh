#!/usr/bin/env bash
# Runs a CI command. On failure, the last lines of its output are published as
# a workflow annotation, so the cause is visible in the run summary (and via the
# API) without downloading logs.
#
#   scripts/ci-step.sh "<title>" <command> [args...]
set -o pipefail
title="$1"
shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=$?
# Note: "$?" read after an if/fi block is the block's status (0), not the command's.
if [ "$status" -eq 0 ]; then
  exit 0
fi
msg=$(tail -n 60 "$log" | sed -e 's/\r//g' -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
echo "::error title=${title} failed::${msg}"
exit "$status"
