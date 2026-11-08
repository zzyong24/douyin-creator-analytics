#!/bin/bash
# 只卸载指定 LaunchAgent，不删除数据、登录档或报告。
set -euo pipefail
LABEL="${DOUYIN_ANALYTICS_LABEL:-com.douyin-analytics}"
if [[ ! "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then echo '无效的 DOUYIN_ANALYTICS_LABEL' >&2; exit 1; fi
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ -L "$DEST" ]]; then echo '目标是符号链接，停止。' >&2; exit 1; fi
if [[ -f "$DEST" ]]; then
  actual_label="$(/usr/bin/plutil -extract Label raw -o - "$DEST")"
  if [[ "$actual_label" != "$LABEL" ]]; then echo '目标Label不匹配，保留文件。' >&2; exit 1; fi
fi
if /bin/launchctl list "$LABEL" >/dev/null 2>&1; then
  /bin/launchctl bootout "gui/$(id -u)/$LABEL"
fi
if [[ -f "$DEST" ]]; then /bin/rm "$DEST"; fi
echo '已卸载定时任务，本地数据保留。'
