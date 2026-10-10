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
if "$@" 2>&1 | tee "$log"; then
  exit 0
fi
status=$?
msg=$(tail -n 60 "$log" | sed -e 's/\r//g' -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
echo "::error title=${title} failed::${msg}"
exit "$status"
