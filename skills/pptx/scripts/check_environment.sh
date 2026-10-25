#!/bin/sh
# PPTX 技能环境预检（POSIX shell）。不探测网络；本地渲染依赖仅在兜底时检查。

set -u

PYTHON_BIN="${PYTHON_BIN:-python3}"
MIN_PY_MAJOR=3
MIN_PY_MINOR=10
PY_MODULES="pptx:python-pptx lxml.etree:lxml PIL:Pillow defusedxml:defusedxml"
FAILURES=0
WARNINGS=0
MISSING_PY=""

log() { printf '%s\n' "$*" >&2; }

log "PPTX 环境预检（$(uname -s) $(uname -m)）"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  log "[缺失] 未找到 ${PYTHON_BIN}；请安装 Python ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+ 或设置 PYTHON_BIN"
  log ""
  log "结果：1 个失败，0 个警告；环境预检未通过。"
  exit 1
fi

if "$PYTHON_BIN" -c "import sys; raise SystemExit(0 if sys.version_info >= ($MIN_PY_MAJOR, $MIN_PY_MINOR) else 1)"; then
  log "[就绪] Python $("$PYTHON_BIN" -c 'import platform; print(platform.python_version())') ($PYTHON_BIN)"
else
  FAILURES=$((FAILURES + 1))
  log "[缺失] Python 需要 ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+"
fi

for spec in $PY_MODULES; do
  module="${spec%%:*}"
  dist="${spec#*:}"
  if "$PYTHON_BIN" -c "import $module" >/dev/null 2>&1; then
    log "[就绪] Python 库 $dist"
  else
    FAILURES=$((FAILURES + 1))
    MISSING_PY="$MISSING_PY $dist"
    log "[缺失] Python 库 $dist"
  fi
done

DIRECT_CONVERT_URL="http://1.48.28.111/xmind/convert-to-image"
if [ -z "${DUMATE_SESSION_ID:-}" ]; then
  ROUTE_URL="$DIRECT_CONVERT_URL"
  ROUTE_LABEL="直连服务（未配置 DUMATE_SESSION_ID；默认禁用，需 DUMATE_ALLOW_REMOTE_CONVERT=1）"
elif [ "${DUMATE_SANDBOX_MODE:-}" = "server" ]; then
  if [ -z "${DUMATE_GATEWAY_URL:-}" ]; then
    ROUTE_URL=""
    ROUTE_LABEL=""
  else
    ROUTE_URL="${DUMATE_GATEWAY_URL%/}/xmind/convert-to-image"
    ROUTE_LABEL="Dumate Web 网关"
  fi
elif [ -n "${DUMATE_SCHEDULER_URL:-}" ]; then
  ROUTE_URL="${DUMATE_SCHEDULER_URL}/api/qianfanproxy/xmind/convert-to-image"
  ROUTE_LABEL="Dumate 桌面端 scheduler 代理"
else
  ROUTE_URL="$DIRECT_CONVERT_URL"
  ROUTE_LABEL="直连服务（桌面端未配置 DUMATE_SCHEDULER_URL；默认禁用，需 DUMATE_ALLOW_REMOTE_CONVERT=1）"
fi

if [ -z "$ROUTE_URL" ]; then
  FAILURES=$((FAILURES + 1))
  log "[错误] Web 端已配置 DUMATE_SESSION_ID，但缺少 DUMATE_GATEWAY_URL"
elif "$PYTHON_BIN" -c 'import sys, urllib.parse; p=urllib.parse.urlparse(sys.argv[1]); valid=p.scheme in ("http", "https") and p.netloc and not p.fragment; raise SystemExit(0 if valid else 1)' "$ROUTE_URL"; then
  log "[就绪] 云端转图路由：${ROUTE_LABEL} → ${ROUTE_URL}"
else
  FAILURES=$((FAILURES + 1))
  log "[错误] 云端转图接口不是有效的 http/https 地址：${ROUTE_URL}"
fi

# 审计修复（P0-2）：直连 fallback 是裸 IP 明文 HTTP，cloud_render.py 默认禁用。
# 这里同步提示路由态势，避免预检报告与实际行为不一致。
if [ "$ROUTE_URL" = "$DIRECT_CONVERT_URL" ] && [ "${DUMATE_ALLOW_REMOTE_CONVERT:-}" != "1" ]; then
  log "[警告] 直连云端转图默认禁用（明文 HTTP 外传用户文档）：设 DUMATE_ALLOW_REMOTE_CONVERT=1 可显式开启；云端失败时将走本地渲染兜底"
elif [ "$ROUTE_URL" = "$DIRECT_CONVERT_URL" ]; then
  log "[警告] 直连云端转图已显式启用（DUMATE_ALLOW_REMOTE_CONVERT=1）：文档内容将明文发往 ${DIRECT_CONVERT_URL}"
fi

FALLBACK="${PPTX_LOCAL_FALLBACK:-install}"
case "$FALLBACK" in
  off|existing|install) log "[配置] 本地兜底模式 ${FALLBACK}（仅云端失败时检查依赖）" ;;
  *)
    FAILURES=$((FAILURES + 1))
    log "[错误] PPTX_LOCAL_FALLBACK 只能是 off、existing 或 install"
    ;;
esac

if [ -n "$MISSING_PY" ]; then
  extra=""
  [ "$(uname -s)" = Linux ] && extra=" --break-system-packages"
  log ""
  log "安装指引："
  log "  Python 库：$PYTHON_BIN -m pip install$extra$MISSING_PY"
fi

log ""
if [ "$FAILURES" -gt 0 ]; then
  log "结果：$FAILURES 个失败，$WARNINGS 个警告；修复后重新执行此脚本。"
  exit 1
fi
log "结果：0 个失败，$WARNINGS 个警告；环境预检通过。"
