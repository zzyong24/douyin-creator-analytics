#!/bin/bash
set -euo pipefail
ANALYTICS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${ANALYTICS_NODE_BIN:-$(command -v node)}"
umask 077
if "$NODE_BIN" "$ANALYTICS_DIR/src/cli.mjs" collect; then
  "$NODE_BIN" "$ANALYTICS_DIR/src/cli.mjs" report
else
  collect_status=$?
  if [[ "$collect_status" -eq 4 ]]; then
    echo 'EGO_PROFILE_LOCKED：Ego占用，本轮调度跳过；不生成报告、不重启浏览器。'
    exit 0
  fi
  exit "$collect_status"
fi
