#!/usr/bin/env bash
# The local runner for day-zero case capture (D03 T04 §38): one instance, cores 0 and 1, and never under 3000 MB of
# available memory. A deferred or failed run exits non-zero so systemd retries it; the status it leaves holds counts,
# never case content. Usage: scripts/glimmer/capture-run.sh
set -u
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The destination is validated by the same code the collector uses (`--print-root`: `~` expanded, never inside a git
# work tree, symlinks resolved) before this script writes anything.
cd "$repo" || exit 1
if ! store="$(node scripts/glimmer/capture-cases.ts --print-root 2>/dev/null)" || [ -z "$store" ]; then
  echo "capture-run: the store destination was refused; nothing was written" >&2
  exit 78
fi
status="$store/capture/1.1/runner-status.json"
mkdir -p "$store/capture/1.1"
chmod 700 "$store/capture" "$store/capture/1.1" 2>/dev/null || true
note() { printf '{"at":"%s","state":"%s","detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" > "$status.tmp" && mv "$status.tmp" "$status"; }
# CAPTURE_MEMINFO and CAPTURE_COMMAND are test seams: the tests point them at a fixture and a stub.
available=$(awk '/MemAvailable/ {print int($2/1024)}' "${CAPTURE_MEMINFO:-/proc/meminfo}")
if [ "${available:-0}" -lt 3000 ]; then
  note deferred "available memory ${available} MB is under 3000 MB"
  exit 75
fi
exec 9> "$store/capture/1.1/.runner.lock"
if ! flock -n 9; then
  note deferred "another capture runner is running"
  exit 75
fi
if taskset -c 0,1 ${CAPTURE_COMMAND:-node scripts/glimmer/capture-cases.ts}; then
  note ok "capture finished"
else
  code=$?
  note failed "capture exited with status $code"
  exit "$code"
fi
