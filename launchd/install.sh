#!/bin/bash
# 安装只检查本机数据/验收/报告，不启动浏览器或立即采集。
set -euo pipefail
MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
LABEL="${DOUYIN_ANALYTICS_LABEL:-com.douyin-analytics}"
if [[ ! "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then echo '无效的 DOUYIN_ANALYTICS_LABEL' >&2; exit 1; fi
NODE_BIN="${ANALYTICS_NODE_BIN:-$(command -v node)}"
export ANALYTICS_NODE_BIN="$NODE_BIN"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ -e "$DEST" || -L "$DEST" ]]; then echo "已存在 $DEST，停止以免覆盖。" >&2; exit 1; fi
if /bin/launchctl list "$LABEL" >/dev/null 2>&1; then
  echo '标签已注册，停止以免覆盖其他配置。' >&2; exit 1
fi
"$NODE_BIN" "$MODULE_DIR/src/cli.mjs" verify-install
umask 077
mkdir -p "$HOME/Library/LaunchAgents"
TEMP_PLIST="$(mktemp "$HOME/Library/LaunchAgents/.douyin-analytics.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT
"$NODE_BIN" --input-type=module - "$MODULE_DIR/launchd/render-plist.mjs" > "$TEMP_PLIST" <<'JS'
import {pathToFileURL} from 'node:url';
const {renderPlist}=await import(pathToFileURL(process.argv[2]));
process.stdout.write(renderPlist());
JS
/usr/bin/plutil -lint "$TEMP_PLIST"
set -o noclobber
/bin/cat "$TEMP_PLIST" > "$DEST"
set +o noclobber
if ! /bin/launchctl bootstrap "gui/$(id -u)" "$DEST"; then
  /bin/rm "$DEST"
  echo '注册失败，已删除本次生成的plist。' >&2; exit 1
fi
echo "已安装：${DEST}；每21600秒运行，RunAtLoad=false，未立即启动。"
