#!/bin/sh
# DOCX 技能环境预检（macOS / Linux）。
#
# 按 PATH -> 登录 shell PATH -> 标准安装位置的顺序解析每个工具，避免把「已安装但不在
# PATH」误判成「缺失」。报告写到 stderr；PATH 修正值以 `PATH_FIX=<目录列表>` 单行写到
# stdout，由调用方解析后拼接（不经 eval，技能目录被替换时不会多出一条命令执行链）：
#
#   ENV_FIX="$(sh scripts/check_environment.sh)"
#   case "$ENV_FIX" in PATH_FIX=?*) PATH="${ENV_FIX#PATH_FIX=}:$PATH"; export PATH ;; esac
#
# 退出码：0 = 通过（可能带警告），1 = 有必需项缺失。
# Windows 用同目录的 check_environment.ps1。

set -u

PYTHON_BIN="${PYTHON_BIN:-python}"
MIN_PY_MAJOR=3
MIN_PY_MINOR=10

# 模块名:发行包名:是否必需
PY_MODULES="docx:python-docx:1 yaml:PyYAML:1 defusedxml:defusedxml:1 lxml:lxml:1"
# 可执行文件:组件名:用途:是否必需
TOOLS="pandoc:Pandoc:公式转OMML和DOCX文本提取:1"

OS="$(uname -s)"
# Git Bash / MSYS2 / Cygwin 下跑的也是本脚本，但安装位置和包管理器是 Windows 的
case "$OS" in
  Darwin) PLATFORM=mac ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) PLATFORM=windows ;;
  *) PLATFORM=linux ;;
esac
ORIG_PATH="$PATH"
FAILURES=0
WARNINGS=0
MISSING_PY=""
MISSING_TOOLS=""
PATH_FIX=""

log() { printf '%s\n' "$*" >&2; }

install_hint() {
  case "$1:$PLATFORM" in
    Pandoc:*) printf 'pip install pypandoc-binary（自带二进制，无需系统包）' ;;
    *)        printf '请使用当前系统的软件包管理器安装 %s' "$1" ;;
  esac
}

# Windows 风格路径（C:\...）转成当前 bash 能用的形式
to_unix_path() {
  [ -n "$1" ] || return 0
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$1" 2>/dev/null
  else
    printf '%s' "$1"
  fi
}

# 登录 shell 的 PATH 里有 Homebrew、conda、asdf 等由用户 profile 注入的目录。
merge_login_path() {
  login_path="$("${SHELL:-/bin/sh}" -lc 'printf %s "$PATH"' 2>/dev/null)" || login_path=""
  [ -n "$login_path" ] && PATH="$PATH:$login_path"
  export PATH
}

# 依次尝试：<EXE>_PATH 环境变量 -> PATH -> 标准安装位置；未找到时输出为空
find_tool() {
  exe="$1"
  var="$(printf '%s' "$exe" | tr 'a-z-' 'A-Z_')_PATH"
  eval "override=\${$var:-}"
  if [ -n "$override" ] && [ -x "$override" ]; then
    printf '%s' "$override"
    return 0
  fi

  found="$(command -v "$exe" 2>/dev/null)" || found=""
  if [ -n "$found" ]; then
    printf '%s' "$found"
    return 0
  fi

  # pypandoc-binary 把 pandoc 装在 Python 环境里，不会进 PATH
  if [ "$exe" = "pandoc" ]; then
    hit="$("$PYTHON_BIN" -c 'import pypandoc; print(pypandoc.get_pandoc_path())' 2>/dev/null)"
    if [ -n "$hit" ] && [ -x "$hit" ]; then
      printf '%s' "$hit"
      return 0
    fi
  fi

  if [ "$PLATFORM" = windows ]; then name="$exe.exe"; else name="$exe"; fi
  case "$PLATFORM" in
    mac) set -- /Applications "$HOME/Applications" /opt /usr/local ;;
    windows)
      local_app="$(to_unix_path "${LOCALAPPDATA:-}")"
      set -- \
        "$(to_unix_path "${ProgramW6432:-}")" \
        "$(to_unix_path "${PROGRAMFILES:-}")" \
        "$(to_unix_path "$(printenv 'ProgramFiles(x86)' 2>/dev/null)")" \
        "${local_app:+$local_app/Microsoft/WinGet/Packages}" \
        "${local_app:+$local_app/Programs}"
      ;;
    *) set -- /opt /usr/local /usr/lib /snap ;;
  esac
  for dir do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    hit="$(find "$dir" -maxdepth 5 -name "$name" -type f 2>/dev/null | head -n 1)"
    if [ -n "$hit" ]; then
      printf '%s' "$hit"
      return 0
    fi
  done
  return 1
}

log "DOCX 环境预检（$OS $(uname -m)）"

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
  log "[缺失] Python 需要 ${MIN_PY_MAJOR}.${MIN_PY_MINOR}+，当前 $("$PYTHON_BIN" -c 'import platform; print(platform.python_version())')"
fi

for spec in $PY_MODULES; do
  module="${spec%%:*}"
  rest="${spec#*:}"
  dist="${rest%%:*}"
  required="${rest#*:}"
  if "$PYTHON_BIN" -c "import $module" >/dev/null 2>&1; then
    log "[就绪] Python 库 $dist"
  elif [ "$required" = "1" ]; then
    FAILURES=$((FAILURES + 1))
    MISSING_PY="$MISSING_PY $dist"
    log "[缺失] Python 库 $dist"
  else
    WARNINGS=$((WARNINGS + 1))
    log "[可选] Python 库 $dist 未安装"
  fi
done

merge_login_path

for spec in $TOOLS; do
  exe="${spec%%:*}"
  rest="${spec#*:}"
  component="${rest%%:*}"
  rest="${rest#*:}"
  purpose="${rest%%:*}"
  required="${rest#*:}"

  resolved="$(find_tool "$exe")"
  if [ -z "$resolved" ]; then
    if [ "$required" = "1" ]; then
      FAILURES=$((FAILURES + 1))
      MISSING_TOOLS="$MISSING_TOOLS $component"
      log "[缺失] ${exe}（${component}，${purpose}）"
    else
      WARNINGS=$((WARNINGS + 1))
      log "[可选] ${exe} 未找到（${component}，${purpose}）"
    fi
    continue
  fi

  log "[就绪] $exe -> $resolved"
  # 合并后的 PATH 只在本脚本内有效，按调用方的原始 PATH 判断是否需要输出修正。
  if ! (PATH="$ORIG_PATH" command -v "$exe" >/dev/null 2>&1); then
    dir="$(dirname "$resolved")"
    case ":$PATH_FIX:" in
      *":$dir:"*) ;;
      *) PATH_FIX="${PATH_FIX:+$PATH_FIX:}$dir" ;;
    esac
  fi
done

if [ -n "$MISSING_PY" ] || [ -n "$MISSING_TOOLS" ]; then
  log ""
  log "安装指引："
  if [ -n "$MISSING_PY" ]; then
    extra=""
    [ "$PLATFORM" = linux ] && extra=" --break-system-packages"
    log "  Python 库：$PYTHON_BIN -m pip install$extra$MISSING_PY"
  fi
  for component in $MISSING_TOOLS; do
    log "  ${component}：$(install_hint "$component")"
  done
fi

log ""
if [ "$FAILURES" -gt 0 ]; then
  log "结果：$FAILURES 个失败，$WARNINGS 个警告；安装以上缺失依赖后重新执行此脚本。"
  exit 1
fi

if [ -n "$PATH_FIX" ]; then
  printf 'PATH_FIX=%s\n' "$PATH_FIX"
  log "以下目录已解析但不在 PATH 中，已输出 PATH 修正值（PATH_FIX）：$PATH_FIX"
fi
log "结果：0 个失败，$WARNINGS 个警告；环境预检通过。"
exit 0
