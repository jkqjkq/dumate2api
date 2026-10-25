"""dumate_find_skill.py — 千帆 skill 候选发现单文件入口（桌面/云端合并版）

子命令：

    # 搜索（候选收集，不预筛 — 留给调用方）
    python3 dumate_find_skill.py search --mode implicit --query "做PPT"
    python3 dumate_find_skill.py search --mode explicit --query "baidu-search"

    # 启用一个已下载但被禁用的 skill（source=local 的候选走这条）
    python3 dumate_find_skill.py enable --slug baidu-search

    # 安装远端候选（source=square 或 hub 的候选走这条）
    python3 dumate_find_skill.py install --slug baidu-search \
        --download-url "https://.../skill.zip" --source square [--version 1.0.0] [--force]

候选来源：
  - local           桌面端：扫描 .skills_disabled/{official,user} 与 global/data/.skills_disabled
                    云端：POST {DUMATE_GATEWAY_URL}/api/dumate/crop/skills/list 后过滤 enabled === false
  - square          apaas-api-sandbox /v2/skill/search?index=baiduMate（千帆广场）
  - hub             apaas-api-sandbox /v2/skill/search?index=clawHub（skill hub）

install / enable 在脚本内部按 runtime 分流:
  - desktop → POST ${DUMATE_HOST_URL}/skill/{install,enable}  (本地 Hono, 无鉴权；
              调用方附带 X-Dumate-Local-Token（<home>/.dumate/local-token），downloadURL
              仅允许 https + 官方域白名单（DUMATE_SKILL_INSTALL_DOMAINS 扩展）)
  - cloud   → POST ${DUMATE_GATEWAY_URL}/api/dumate/crop/skills/{import/url,enable}
              (真网关, sandbox 内 middleware 注入 X-Authorization)

云端和桌面 install 的 body 字段名不一致(下方 _CLOUD_SOURCE_MAP 有翻译),
LLM 不应该直接调 raw curl —— 全部经过本脚本以避免踩坑。

两个云端 source 并发拉取；implicit / explicit 仅影响 LLM 提取 query 的方式，不影响后端检索范围。
stdout 仅打印 sentinel 包裹的 JSON（search 是候选列表, install/enable 是结果对象）；
其他信息一律走 stderr。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple
from urllib.parse import quote, urlparse

import requests

# ── 常量 ─────────────────────────────────────────────────────────────────

BASE_URL = "https://appbuilder.baidu.com"
CROP_BASE_URL = "http://dumate-web.sdns.baidu.com"

SEARCH_TIMEOUT = int(os.environ.get("FIND_SKILL_SEARCH_TIMEOUT", "8"))
INSTALL_TIMEOUT = int(os.environ.get("FIND_SKILL_INSTALL_TIMEOUT", "60"))
ENABLE_TIMEOUT = int(os.environ.get("FIND_SKILL_ENABLE_TIMEOUT", "30"))

CANDIDATES_SENTINEL_BEGIN = "===CANDIDATES==="
CANDIDATES_SENTINEL_END = "===END==="

CLOUD_INSTALLED_LIST_PATH = "/api/dumate/crop/skills/list"
CLOUD_INSTALL_PATH = "/api/dumate/crop/skills/import/url"
CLOUD_ENABLE_PATH = "/api/dumate/crop/skills/enable"

# search 用的 "square"/"hub" ↔ 云端 install 上游要的 (source, scope) 语义翻译:
#   square (千帆广场) → scope=global, source=official → 装到「来自广场」tab
#   hub    (skill hub) → scope=project, source=user    → 装到「自定义安装」tab
# 这套映射跟 server/src/skill/skill.ts install() cloud 分支保持一致。
_CLOUD_SOURCE_MAP = {
    "square": {"source": "official", "scope": "global"},
    "hub":    {"source": "user",     "scope": "project"},
}


def log(msg: str, *, level: str = "info") -> None:
    """统一日志：全部写 stderr，避免污染 stdout。"""
    print(f"[find-skill][{level}] {msg}", file=sys.stderr, flush=True)


def detect_runtime() -> str:
    """判断当前运行环境。

    返回值：
      - cloud:  Dumate server sandbox，优先使用 DUMATE_GATEWAY_URL。
      - desktop: 桌面端环境，优先使用 DUMATE_SCHEDULER_URL 与 XDG_DATA_HOME。
    """
    sandbox_mode = os.environ.get("DUMATE_SANDBOX_MODE", "").lower()
    if sandbox_mode == "server":
        return "cloud"
    return "desktop"


def get_proxy_parmas(original_url: str, runtime: Optional[str] = None) -> Tuple[str, Dict[str, str]]:
    """按桌面/云端环境改写上游 URL，并注入 Dumate 请求头。"""
    session_id = os.environ.get("DUMATE_SESSION_ID")
    if not session_id:
        return original_url, {}

    runtime = runtime or detect_runtime()
    parsed = urlparse(original_url)
    extra_headers: Dict[str, str] = {
        "X-Dumate-Session-Id": session_id,
    }

    request_id = os.environ.get("DUMATE_REQUEST_ID", "")
    if request_id:
        extra_headers["X-Dumate-Request-Id"] = request_id

    if runtime == "cloud":
        gateway_url = os.environ.get("DUMATE_GATEWAY_URL")
        if not gateway_url:
            return "", {}
        url = gateway_url.rstrip("/") + parsed.path
        dtoken = os.environ.get("DUMATE_DTOKEN")
        if dtoken:
            extra_headers["Authorization"] = f"Bearer {dtoken}"
    else:
        scheduler_url = os.environ.get("DUMATE_SCHEDULER_URL")
        if not scheduler_url:
            return original_url, {}
        url = f"{scheduler_url}/api/qianfanproxy{parsed.path}"

    if parsed.query:
        url += f"?{parsed.query}"
    return url, extra_headers


def build_headers(extra: Optional[dict] = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if extra:
        headers.update(extra)
    return headers


# ── 安装链加固（审计 P0-3）────────────────────────────────────────────────
#
# 桌面端 /skill/install 是本地无鉴权端点，downloadURL 又来自远端搜索结果：
# 提示注入或本机恶意进程都能借它静默安装任意技能，而安装的技能随后会被
# agent runtime 执行（SKILL.md 里还有 eval 模式，等于直接命令执行）。
# 桌面端 Hono 端点不在本仓库，本脚本是必经调用方，在这里把能收的口子全收掉：
#   1. downloadURL 仅允许 https + 官方域白名单（DUMATE_SKILL_INSTALL_DOMAINS 可扩展）
#   2. 本地请求携带 X-Dumate-Local-Token：token 存 <home>/.dumate/local-token，
#      首用时生成。桌面端侧修复时校验同一路径文件与该头一致才放行
#      （WriteDefault 模式：文件由任一侧先写均可，O_EXCL 防覆盖）
#   3. 调用方给了 --sha256 就透传给端点校验；没给则显式 WARN 留痕
#   4. DUMATE_HOST_URL 指向非回环地址时 WARN（token 会走明文 HTTP 出网段）

DEFAULT_INSTALL_DOMAINS = ("bcebos.com", "baidubce.com", "baidu.com")

LOCAL_TOKEN_HEADER = "X-Dumate-Local-Token"
_LOCAL_TOKEN_FILE = Path.home() / ".dumate" / "local-token"


def _install_domain_allowlist() -> Tuple[str, ...]:
    """默认官方域 + DUMATE_SKILL_INSTALL_DOMAINS（逗号分隔）扩展。"""
    domains = list(DEFAULT_INSTALL_DOMAINS)
    for d in os.environ.get("DUMATE_SKILL_INSTALL_DOMAINS", "").split(","):
        d = d.strip().lower().lstrip(".")
        if d and d not in domains:
            domains.append(d)
    return tuple(domains)


def validate_download_url(url: str) -> Tuple[bool, str]:
    """install 链的 URL 闸：仅 https + 白名单域。返回 (ok, 原因)。"""
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme != "https":
        return False, f"downloadURL 必须是 https（当前 scheme: {parsed.scheme or '无'}）"
    if parsed.username or parsed.password:
        return False, "downloadURL 不允许携带 userinfo"
    host = (parsed.hostname or "").lower()
    if not host:
        return False, "downloadURL 缺少主机名"
    for d in _install_domain_allowlist():
        if host == d or host.endswith("." + d):
            return True, ""
    return False, (
        f"downloadURL 域 {host} 不在白名单（默认 {'/'.join(DEFAULT_INSTALL_DOMAINS)}，"
        "可用 DUMATE_SKILL_INSTALL_DOMAINS 逗号分隔扩展）"
    )


def _local_token() -> str:
    """本地端点鉴权 token。env DUMATE_LOCAL_TOKEN 优先，否则读写 token 文件。"""
    env_token = os.environ.get("DUMATE_LOCAL_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        if _LOCAL_TOKEN_FILE.exists():
            return _LOCAL_TOKEN_FILE.read_text(encoding="utf-8").strip()
        token = secrets.token_hex(32)
        _LOCAL_TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            # O_EXCL：与桌面端侧（若已修复）并发首写不互相覆盖
            fd = os.open(str(_LOCAL_TOKEN_FILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(token)
            return token
        except FileExistsError:
            return _LOCAL_TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError as e:
        log(f"local token file unavailable ({e})：桌面端修好后将无法通过鉴权，可用 DUMATE_LOCAL_TOKEN 显式指定", level="warn")
        return ""


def _warn_host_exposure(host_url: str) -> None:
    """桌面端地址非回环时告警：无鉴权端点 + 明文 token 都会暴露到网段。"""
    try:
        host = (urlparse(str(host_url)).hostname or "").lower()
    except ValueError:
        host = ""
    if host and host not in ("127.0.0.1", "::1", "localhost"):
        log(f"桌面端地址 {host} 非回环：/skill/* 端点与本地 token 将经明文 HTTP 暴露到网段", level="warn")


_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _apply_install_guard(args: argparse.Namespace) -> Optional[dict]:
    """install 共用闸：URL 白名单 + sha256 形态校验。不通过返回 None（已输出结果）。"""
    ok, why = validate_download_url(getattr(args, "download_url", "") or "")
    if not ok:
        log(f"install blocked: {why}", level="error")
        _emit_result("install", False, slug=args.slug, error=why)
        return None
    sha = getattr(args, "sha256", None)
    if sha:
        if not _SHA256_RE.match(sha.strip()):
            log("--sha256 必须是 64 位十六进制", level="error")
            _emit_result("install", False, slug=args.slug, error="--sha256 must be 64 hex chars")
            return None
        sha = sha.strip().lower()
    else:
        log("install 无已知 sha256：无法校验包完整性（URL 已限官方域白名单），建议上游提供哈希后传入 --sha256", level="warn")
    return {"sha256": sha}


# ── 以下载 skill 枚举 ──────────────────────────────────────────────────────


@dataclass
class LocalSkill:
    slug: str
    name: str
    description: str
    category: str
    path: str
    source: str = "local"


def _xdg_qianfan_root() -> Optional[Path]:
    """从 XDG_DATA_HOME 反推 qianfan_desk_xdg 根目录（路径形如 .../qianfan_desk_xdg/{uid}/data）。"""
    workdir = os.environ.get("XDG_DATA_HOME")
    if not workdir:
        return None
    parts = Path(workdir).parts
    try:
        idx = parts.index("qianfan_desk_xdg")
    except ValueError:
        return None
    if idx + 2 >= len(parts):
        return None
    return Path(*parts[: idx + 1])


def _xdg_disabled_roots() -> list[Path]:
    """桌面端已装但被禁用的 skill 根目录。

    扫三条路径：
      - {XDG_DATA_HOME}/.skills_disabled/official/<slug>/SKILL.md  ← 账号级：官方预装禁用
      - {XDG_DATA_HOME}/.skills_disabled/user/<slug>/SKILL.md      ← 账号级：用户自定义禁用
      - {qianfan_desk_xdg}/global/data/.skills_disabled/<slug>/SKILL.md  ← 全局预装禁用

    注：全局预装路径必须由宿主 sandbox 挂载到 VM 中才可访问；
    若未挂载，`root.exists()` 在 VM 内会直接 False，enumerate_local_skills 会静默跳过。
    """
    out: list[Path] = []
    workdir = os.environ.get("XDG_DATA_HOME")
    if workdir:
        out.append(Path(workdir) / ".skills_disabled" / "official")
        out.append(Path(workdir) / ".skills_disabled" / "user")
    gskills = _xdg_qianfan_root()
    if gskills is not None:
        out.append(gskills / "global" / "data" / ".skills_disabled")
    return out


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(text: str) -> dict:
    """轻量 YAML frontmatter 解析，支持顶层 `key: value` 标量 + `>` / `|` 多行折叠/字面量。

    避免引入 PyYAML 依赖。嵌套字段会被忽略——本 skill 只关心 name / description / category 三个顶层标量。
    """
    m = _FRONTMATTER_RE.search(text)
    if not m:
        return {}
    out: dict[str, str] = {}
    lines = m.group(1).splitlines()
    i = 0
    while i < len(lines):
        raw_line = lines[i]
        line = raw_line.strip()
        if not line or line.startswith("#"):
            i += 1
            continue
        if raw_line[:1] in (" ", "\t"):
            i += 1
            continue
        if ":" not in raw_line:
            i += 1
            continue
        key, _, value = raw_line.partition(":")
        key = key.strip()
        value = value.strip()
        if not key:
            i += 1
            continue
        if value in (">", "|", ">-", "|-", ">+", "|+"):
            fold = value.startswith(">")
            buf: list[str] = []
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if not nxt.strip():
                    buf.append("")
                    i += 1
                    continue
                if not nxt.startswith((" ", "\t")):
                    break
                buf.append(nxt.lstrip())
                i += 1
            while buf and buf[-1] == "":
                buf.pop()
            if fold:
                paras: list[str] = []
                cur: list[str] = []
                for b in buf:
                    if b == "":
                        if cur:
                            paras.append(" ".join(cur))
                            cur = []
                    else:
                        cur.append(b)
                if cur:
                    paras.append(" ".join(cur))
                out[key] = "\n".join(paras).strip()
            else:
                out[key] = "\n".join(buf).strip()
            continue
        if not value:
            i += 1
            continue
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        out[key] = value
        i += 1
    return out


def parse_skill_md(path: Path) -> Optional[LocalSkill]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        log(f"read fail {path}: {e}", level="warn")
        return None
    fm = _parse_frontmatter(text)
    name = fm.get("name") or path.parent.name
    description = fm.get("description") or ""
    category = fm.get("category", "")
    slug = path.parent.name
    return LocalSkill(
        slug=slug,
        name=name,
        description=description,
        category=category,
        path=str(path),
    )


def enumerate_local_skills_desktop() -> list[LocalSkill]:
    """桌面端：扫所有 disabled 根目录下的 <slug>/SKILL.md，按 slug 去重。"""
    found: dict[str, LocalSkill] = {}
    for root in _xdg_disabled_roots():
        if not root.exists() or not root.is_dir():
            continue
        try:
            entries = sorted(root.iterdir())
        except OSError as e:
            log(f"list {root} fail: {e}", level="warn")
            continue
        for entry in entries:
            if not entry.is_dir():
                continue
            chosen: Optional[Path] = next(
                (c for c in (entry / "SKILL.md", entry / "skill.md") if c.exists()),
                None,
            )
            if chosen is None:
                continue
            parsed = parse_skill_md(chosen)
            if parsed is None or parsed.slug in found:
                continue
            found[parsed.slug] = parsed
    return list(found.values())


def enumerate_local_skills_cloud(runtime: str) -> list[LocalSkill]:
    """POST /api/dumate/crop/skills/list → filter enabled === false。

    云端没有"路径"概念，候选项以 name 作为 slug；displayName / description / bosZipURL
    会一并返回，供 LLM 决策与后续安装使用。
    """
    url, extra_headers = get_proxy_parmas(f"{CROP_BASE_URL}{CLOUD_INSTALLED_LIST_PATH}", runtime)
    if not url:
        log("cloud disabled list skipped: DUMATE_GATEWAY_URL not set", level="warn")
        return []
    try:
        resp = requests.post(url, json={}, headers=build_headers(extra_headers), timeout=SEARCH_TIMEOUT)
    except requests.RequestException as e:
        log(f"cloud disabled list request fail: {e}", level="warn")
        return []
    if resp.status_code != 200:
        log(f"cloud disabled list http {resp.status_code}: {resp.text[:200]}", level="warn")
        return []
    try:
        body = resp.json()
    except ValueError as e:
        log(f"cloud disabled list json parse fail: {e}", level="warn")
        return []
    items = body.get("result") if isinstance(body, dict) else None
    if not isinstance(items, list):
        # 兜底：有些后端可能直接返回 list
        items = body if isinstance(body, list) else []

    out: list[LocalSkill] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("enabled") is not False:
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        display_name = str(item.get("displayName") or "").strip() or name
        bos_zip_url = str(item.get("bosZipURL") or "").strip()
        out.append(
            LocalSkill(
                slug=name,
                name=display_name,
                description=str(item.get("description") or ""),
                category=str(item.get("category") or ""),
                path=bos_zip_url or f"cloud://{name}",
            )
        )
    return out


def enumerate_local_skills(runtime: str) -> list[LocalSkill]:
    if runtime == "cloud":
        return enumerate_local_skills_cloud(runtime)
    return enumerate_local_skills_desktop()


# ── 远端搜索（千帆广场 + skill hub）──────────────────────────────────────


@dataclass
class RemoteSkill:
    slug: str
    name: str
    description: str
    version: Optional[str]
    source: str  # "square" or "hub"
    downloadURL: Optional[str] = None


def _post_unified_search(query: str, index: str, limit: int, runtime: str) -> list[dict]:
    """搜索 skill 候选；走 qianfanproxy（桌面端经 scheduler，web 端经 gateway）。
    `index` 取 `baiduMate`（千帆广场）/ `clawHub`（skill hub）。
    """
    original_url = f"{BASE_URL}/v2/skill/search"
    url, extra_headers = get_proxy_parmas(original_url, runtime)
    if not url:
        log(f"search index={index} skipped: proxy url unavailable", level="warn")
        return []
    payload = {"index": index, "query": query, "topK": limit if limit > 0 else 10}
    try:
        resp = requests.post(url, json=payload, headers=build_headers(extra_headers), timeout=SEARCH_TIMEOUT)
    except requests.RequestException as e:
        log(f"search index={index} request fail: {e}", level="warn")
        return []
    if resp.status_code != 200:
        log(f"search index={index} http {resp.status_code}: {resp.text[:200]}", level="warn")
        return []
    try:
        body = resp.json()
    except ValueError as e:
        log(f"search index={index} json parse fail: {e}", level="warn")
        return []
    skills = body.get("skills")
    if not isinstance(skills, list):
        return []
    return skills[:limit] if limit > 0 else skills


def _to_remote(items: Iterable[dict], source: str) -> list[RemoteSkill]:
    out: list[RemoteSkill] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        slug = str(item.get("slug") or "").strip()
        if not slug:
            continue
        download_url = item.get("downloadURL")
        if isinstance(download_url, str):
            download_url = download_url.strip() or None
        else:
            download_url = None
        out.append(
            RemoteSkill(
                slug=slug,
                name=str(item.get("name") or slug),
                description=str(item.get("description") or ""),
                version=(str(item["version"]) if item.get("version") else None),
                source=source,
                downloadURL=download_url,
            )
        )
    return out


def search_remote_concurrent(
    query: str,
    *,
    runtime: str,
    square_limit: int,
    hub_limit: int,
) -> tuple[list[RemoteSkill], list[RemoteSkill]]:
    """并发拉取 baiduMate + clawHub 两个 index。返回 (square, hub)。"""
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f_sq = executor.submit(_post_unified_search, query, "baiduMate", square_limit, runtime)
        f_hub = executor.submit(_post_unified_search, query, "clawHub", hub_limit, runtime)
        sq_items = f_sq.result()
        hub_items = f_hub.result()
    return _to_remote(sq_items, "square"), _to_remote(hub_items, "hub")


# ── 候选归一与去重 ───────────────────────────────────────────────────────


@dataclass
class Candidate:
    """输出给主会话的统一候选结构。"""
    idx: int
    source: str  # local / square / hub
    slug: str
    name: str
    description: str
    version: Optional[str] = None
    downloadURL: Optional[str] = None


def _safe_truncate(text: str, n: int) -> str:
    """安全截断长描述。"""
    if not text:
        return ""
    if len(text) <= n:
        return text
    return text[: n - 1] + "…"


def merge_candidates(
    locals_: list[LocalSkill],
    remotes: list[RemoteSkill],
    *,
    desc_limit: int = 300,
) -> list[Candidate]:
    """合并并按 slug 去重。优先级：local > square > hub（保留先入的）。"""
    seen: set[str] = set()
    out: list[Candidate] = []
    for s in locals_:
        if s.slug in seen:
            continue
        seen.add(s.slug)
        out.append(
            Candidate(
                idx=len(out),
                source="local",
                slug=s.slug,
                name=s.name,
                description=_safe_truncate(s.description, desc_limit),
            )
        )
    for s in remotes:
        if s.slug in seen:
            continue
        seen.add(s.slug)
        out.append(
            Candidate(
                idx=len(out),
                source=s.source,
                slug=s.slug,
                name=s.name,
                description=_safe_truncate(s.description, desc_limit),
                version=s.version,
                downloadURL=s.downloadURL,
            )
        )
    return out


def candidates_summary(candidates: list[Candidate]) -> dict:
    return {
        "local": sum(1 for c in candidates if c.source == "local"),
        "square": sum(1 for c in candidates if c.source == "square"),
        "hub": sum(1 for c in candidates if c.source == "hub"),
    }


def dump_candidates(
    *,
    mode: str,
    query: str,
    candidates: list[Candidate],
    notes: Optional[list[str]] = None,
) -> None:
    """sentinel 包裹的单行 JSON 候选列表，供主会话读取后筛选。"""
    payload = {
        "mode": mode,
        "query": query,
        "counts": candidates_summary(candidates),
        "candidates": [
            {
                "source": c.source,
                "slug": c.slug,
                "name": c.name,
                "description": c.description,
                "version": c.version,
                "downloadURL": c.downloadURL,
            }
            for c in candidates
        ],
        "notes": notes or [],
    }
    print(CANDIDATES_SENTINEL_BEGIN)
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(CANDIDATES_SENTINEL_END)


# ── 子命令实现 ───────────────────────────────────────────────────────────


def _emit_result(action: str, ok: bool, **fields) -> None:
    """把 install/enable 结果按 sentinel + 单行 JSON 输出，跟 search 保持一致。

    payload 结构:
      {"action": "install"|"enable", "ok": bool, ...fields}
    fields 通常包含: slug / http / message / error / code
    """
    payload = {"action": action, "ok": ok, **fields}
    print(CANDIDATES_SENTINEL_BEGIN)
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(CANDIDATES_SENTINEL_END)


def _response_fields(resp: requests.Response) -> dict:
    """保留官方接口返回的 Skill.Info 字段，尤其是顶层 content。"""
    try:
        body = resp.json()
    except ValueError:
        return {}
    if not isinstance(body, dict):
        return {}
    # action/result metadata is supplied by _emit_result; keep the API payload flat
    return {
        key: value
        for key, value in body.items()
        if key not in {"action", "ok", "slug", "http", "runtime", "message", "code"}
    }


def _cloud_body_ok(body: object) -> Tuple[bool, str, object]:
    """检查云端网关 envelope。返回 (ok, message, code)。

    - 网关正常响应: {logId, code, message, success, result} (code==0 或 success==true 视为成功)
    - 网关鉴权/限流 error 响应: {error_code, error_message} (不同 envelope, 也要能提取 msg)

    与 server/src/skill/skill.ts enable()/install() 云端分支判定一致。
    """
    if not isinstance(body, dict):
        return False, "cloud response is not a JSON object", None
    ok = body.get("code") == 0 or body.get("success") is True
    # 两种 envelope 优先级: 业务 message > 网关 error_message > 兜底
    msg = body.get("message") or body.get("error_message") or (
        "ok" if ok else "cloud call failed"
    )
    code = body.get("code") if body.get("code") is not None else body.get("error_code")
    return ok, str(msg), code


def cmd_install(args: argparse.Namespace) -> int:
    """安装远端候选(source=square 或 hub)。runtime 内部分流:
      - desktop: 打本地 Hono /skill/install
      - cloud:   打 gateway /api/dumate/crop/skills/import/url (body 字段名/source 语义要翻译)
    """
    if args.source not in _CLOUD_SOURCE_MAP:
        log(f"install: unknown --source '{args.source}', expected 'square' or 'hub'", level="error")
        _emit_result("install", False, slug=args.slug,
                     error=f"unknown source '{args.source}', expected 'square' or 'hub'")
        return 2

    runtime = detect_runtime()
    log(f"install runtime={runtime} slug={args.slug} source={args.source}", level="info")
    if runtime == "desktop":
        return _install_desktop(args)
    return _install_cloud(args)


def _install_desktop(args: argparse.Namespace) -> int:
    host_url = os.environ.get("DUMATE_HOST_URL")
    if not host_url:
        log("install desktop: DUMATE_HOST_URL missing", level="error")
        _emit_result("install", False, slug=args.slug,
                     error="DUMATE_HOST_URL not set (desktop runtime)")
        return 1

    guard = _apply_install_guard(args)
    if guard is None:
        return 2

    body: Dict[str, object] = {
        "slug": args.slug,
        "downloadURL": args.download_url,
        "source": args.source,  # Hono /skill/install 接受 "square"|"hub" 原值
    }
    if args.version:
        body["version"] = args.version
    if args.force:
        body["force"] = True
    if guard["sha256"]:
        body["sha256"] = guard["sha256"]  # 桌面端修复后按它校验包完整性
    _warn_host_exposure(host_url)
    headers = build_headers()
    token = _local_token()
    if token:
        headers[LOCAL_TOKEN_HEADER] = token
    url = f"{host_url.rstrip('/')}/skill/install"
    try:
        resp = requests.post(url, json=body, headers=headers, timeout=INSTALL_TIMEOUT)
    except requests.RequestException as e:
        log(f"install desktop request fail: {e}", level="error")
        _emit_result("install", False, slug=args.slug, error=f"request failed: {e}")
        return 1

    if resp.status_code == 200:
        _emit_result("install", True, slug=args.slug, http=200, runtime="desktop",
                     message="ok", **_response_fields(resp))
        return 0
    log(f"install desktop http {resp.status_code}: {resp.text[:300]}", level="warn")
    _emit_result("install", False, slug=args.slug, http=resp.status_code,
                 runtime="desktop", error=resp.text[:400])
    return 1


def _install_cloud(args: argparse.Namespace) -> int:
    if not os.environ.get("DUMATE_GATEWAY_URL"):
        log("install cloud: DUMATE_GATEWAY_URL missing", level="error")
        _emit_result("install", False, slug=args.slug,
                     error="DUMATE_GATEWAY_URL not set (cloud runtime)")
        return 1

    guard = _apply_install_guard(args)
    if guard is None:
        return 2

    translation = _CLOUD_SOURCE_MAP[args.source]
    body: Dict[str, object] = {
        "slug": args.slug,
        "url": args.download_url,               # 云端字段是 `url`，不是 `downloadURL`
        "source": translation["source"],         # official / user
        "scope": translation["scope"],           # global / project
    }
    if args.version:
        body["version"] = args.version
    if args.force:
        body["overwrite"] = True                 # 云端字段是 `overwrite`，不是 `force`
    if guard["sha256"]:
        body["sha256"] = guard["sha256"]
    url, extra_headers = get_proxy_parmas(f"{BASE_URL}{CLOUD_INSTALL_PATH}", "cloud")
    if not url:
        log("install cloud: gateway proxy resolve failed", level="error")
        _emit_result("install", False, slug=args.slug,
                     error="gateway proxy resolve failed (missing DUMATE_SESSION_ID?)")
        return 1

    try:
        resp = requests.post(url, json=body, headers=build_headers(extra_headers),
                             timeout=INSTALL_TIMEOUT)
    except requests.RequestException as e:
        log(f"install cloud request fail: {e}", level="error")
        _emit_result("install", False, slug=args.slug, error=f"request failed: {e}")
        return 1

    try:
        body_json = resp.json()
    except ValueError:
        log(f"install cloud non-json body: {resp.text[:200]}", level="warn")
        _emit_result("install", False, slug=args.slug, http=resp.status_code,
                     runtime="cloud", error=f"non-json body: {resp.text[:200]}")
        return 1

    ok, msg, code = _cloud_body_ok(body_json)
    ok = 200 <= resp.status_code < 300 and ok
    if ok:
        _emit_result("install", True, slug=args.slug, http=resp.status_code,
                     runtime="cloud", code=code, message=msg,
                     **_response_fields(resp))
        return 0
    log(f"install cloud failed: http={resp.status_code} code={code} msg={msg}", level="warn")
    _emit_result("install", False, slug=args.slug, http=resp.status_code,
                 runtime="cloud", code=code, error=msg)
    return 1


def cmd_enable(args: argparse.Namespace) -> int:
    """启用一个已下载但被禁用的 skill(source=local 的候选走这条)。runtime 分流:
      - desktop: 打本地 Hono /skill/enable, body {slug}
      - cloud:   打 gateway /api/dumate/crop/skills/enable?name=<slug>, 无 body
    """
    runtime = detect_runtime()
    log(f"enable runtime={runtime} slug={args.slug}", level="info")
    if runtime == "desktop":
        return _enable_desktop(args)
    return _enable_cloud(args)


def _enable_desktop(args: argparse.Namespace) -> int:
    host_url = os.environ.get("DUMATE_HOST_URL")
    if not host_url:
        log("enable desktop: DUMATE_HOST_URL missing", level="error")
        _emit_result("enable", False, slug=args.slug,
                     error="DUMATE_HOST_URL not set (desktop runtime)")
        return 1

    _warn_host_exposure(host_url)
    headers = build_headers()
    token = _local_token()
    if token:
        headers[LOCAL_TOKEN_HEADER] = token
    url = f"{host_url.rstrip('/')}/skill/enable"
    try:
        resp = requests.post(url, json={"slug": args.slug},
                             headers=headers, timeout=ENABLE_TIMEOUT)
    except requests.RequestException as e:
        log(f"enable desktop request fail: {e}", level="error")
        _emit_result("enable", False, slug=args.slug, error=f"request failed: {e}")
        return 1

    if resp.status_code == 200:
        _emit_result("enable", True, slug=args.slug, http=200, runtime="desktop",
                     message="ok", **_response_fields(resp))
        return 0
    log(f"enable desktop http {resp.status_code}: {resp.text[:300]}", level="warn")
    _emit_result("enable", False, slug=args.slug, http=resp.status_code,
                 runtime="desktop", error=resp.text[:400])
    return 1


def _enable_cloud(args: argparse.Namespace) -> int:
    if not os.environ.get("DUMATE_GATEWAY_URL"):
        log("enable cloud: DUMATE_GATEWAY_URL missing", level="error")
        _emit_result("enable", False, slug=args.slug,
                     error="DUMATE_GATEWAY_URL not set (cloud runtime)")
        return 1

    # 云端 enable 走 query string ?name=<slug>, body 为空。
    # 借道 get_proxy_parmas: 传含 query 的 fake URL, 内部会把 host 换成 gateway, 保留 query。
    original_url = f"{BASE_URL}{CLOUD_ENABLE_PATH}?name={quote(args.slug, safe='')}"
    url, extra_headers = get_proxy_parmas(original_url, "cloud")
    if not url:
        log("enable cloud: gateway proxy resolve failed", level="error")
        _emit_result("enable", False, slug=args.slug,
                     error="gateway proxy resolve failed (missing DUMATE_SESSION_ID?)")
        return 1

    try:
        resp = requests.post(url, headers=build_headers(extra_headers),
                             timeout=ENABLE_TIMEOUT)
    except requests.RequestException as e:
        log(f"enable cloud request fail: {e}", level="error")
        _emit_result("enable", False, slug=args.slug, error=f"request failed: {e}")
        return 1

    try:
        body_json = resp.json()
    except ValueError:
        log(f"enable cloud non-json body: {resp.text[:200]}", level="warn")
        _emit_result("enable", False, slug=args.slug, http=resp.status_code,
                     runtime="cloud", error=f"non-json body: {resp.text[:200]}")
        return 1

    ok, msg, code = _cloud_body_ok(body_json)
    ok = 200 <= resp.status_code < 300 and ok
    if ok:
        _emit_result("enable", True, slug=args.slug, http=resp.status_code,
                     runtime="cloud", code=code, message=msg,
                     **_response_fields(resp))
        return 0
    log(f"enable cloud failed: http={resp.status_code} code={code} msg={msg}", level="warn")
    _emit_result("enable", False, slug=args.slug, http=resp.status_code,
                 runtime="cloud", code=code, error=msg)
    return 1


def cmd_search(args: argparse.Namespace) -> int:
    query = args.query.strip()
    if not query:
        log("empty query", level="error")
        return 2

    mode = args.mode
    runtime = detect_runtime()
    log(f"runtime={runtime}", level="info")
    notes: list[str] = [f"runtime:{runtime}"]

    locals_all = enumerate_local_skills(runtime)
    locals_ = locals_all[: args.local_limit] if args.local_limit > 0 else locals_all
    if len(locals_all) > len(locals_):
        notes.append(f"local_truncated:{len(locals_all)}->{len(locals_)}")
        log(f"local truncated {len(locals_all)} -> {len(locals_)} by --local-limit", level="warn")

    squares, hubs = search_remote_concurrent(
        query,
        runtime=runtime,
        square_limit=args.square_limit,
        hub_limit=args.hub_limit,
    )
    if not squares:
        notes.append("square_empty_or_failed")
    if not hubs:
        notes.append("hub_empty_or_failed")

    candidates = merge_candidates(locals_, squares + hubs)
    log(
        f"mode={mode} candidates: local={sum(1 for c in candidates if c.source=='local')}, "
        f"square={sum(1 for c in candidates if c.source=='square')}, "
        f"hub={sum(1 for c in candidates if c.source=='hub')}",
        level="info",
    )
    dump_candidates(mode=mode, query=query, candidates=candidates, notes=notes)
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="dumate_find_skill: 千帆 skill 发现/启用/安装 (桌面/云端合并版, runtime 内部分流)",
    )
    sub = parser.add_subparsers(dest="command", help="子命令")

    p_search = sub.add_parser("search", help="候选收集（--mode 切换隐式/显式）")
    p_search.add_argument(
        "--mode",
        required=True,
        choices=["implicit", "explicit"],
        help="发现模式：implicit=按能力/任务描述，explicit=按 skill 名称/slug",
    )
    p_search.add_argument(
        "--query",
        required=True,
        help="隐式时为能力/任务自然语言；显式时为 skill 名称/slug/关键词",
    )
    p_search.add_argument(
        "--local-limit",
        type=int,
        default=0,
        help="已下载候选最多保留数量（默认 0=全部）",
    )
    p_search.add_argument("--square-limit", type=int, default=5, help="千帆广场最多候选数（默认 5）")
    p_search.add_argument(
        "--hub-limit",
        type=int,
        default=5,
        help="skill hub 最多候选数（默认 5）",
    )

    p_enable = sub.add_parser("enable", help="启用一个已下载但被禁用的 skill (source=local 走这条)")
    p_enable.add_argument("--slug", required=True, help="skill slug (原样传候选 JSON 里的 slug 字段)")

    p_install = sub.add_parser(
        "install",
        help="安装远端 skill (source=square 或 hub 走这条; runtime 内部分流 desktop/cloud)",
    )
    p_install.add_argument("--slug", required=True, help="skill slug (原样传候选 JSON 里的 slug 字段)")
    p_install.add_argument(
        "--download-url",
        required=True,
        dest="download_url",
        help="候选 JSON 里的 downloadURL 字段, 原样传",
    )
    p_install.add_argument(
        "--source",
        required=True,
        choices=["square", "hub"],
        help="候选来源: square=千帆广场, hub=skill hub。云端会自动翻译成 (official/global) 或 (user/project)",
    )
    p_install.add_argument(
        "--sha256",
        default=None,
        help="可选；安装包 sha256（64 位十六进制）。候选 JSON 有哈希就传，脚本会透传给端点校验；缺省时 WARN 留痕",
    )
    p_install.add_argument("--version", default=None, help="可选; 候选 JSON 里的 version 字段有就传")
    p_install.add_argument("--force", action="store_true", help="覆盖已装同名 skill (desktop=force, cloud=overwrite)")

    args = parser.parse_args(argv)

    if args.command == "search":
        return cmd_search(args)
    if args.command == "enable":
        return cmd_enable(args)
    if args.command == "install":
        return cmd_install(args)
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
