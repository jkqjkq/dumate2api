#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 dumate2api 的一条通道配置写进 cc-switch 的 provider 表。

为什么要有这个文件：管理端要支持「选好通道直接添加到 cc-switch」，
而 cc-switch 是 Tauri 单 exe，没有 CLI 也没有本地 API，唯一的接口就是它的
SQLite 库 `~/.cc-switch/cc-switch.db`。Node 侧又是零依赖（没有 better-sqlite3），
所以这里借系统的 python3 来写。

调用方式（由 src/admin/routes/ccswitch.js 调用）：

    python ccswitch-writer.py '{"action":"upsert","provider":{...}}'

stdout 输出一行 JSON，Node 侧解析：{"ok":true,"id":"...","created":true}
或 {"ok":false,"error":"..."}

幂等：同 id 的 provider 存在则**更新**（而不是插一条重复的）。
安全：每次写前自动备份 db（只保留最近 5 份）。
"""
import json
import os
import shutil
import sqlite3
import sys
import time

DB = os.path.join(os.path.expanduser("~"), ".cc-switch", "cc-switch.db")
KEEP_BACKUPS = 5


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.exit(0)


def backup():
    bak = f"{DB}.bak-api-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(DB, bak)
    # 只留最近几份，避免无限堆积
    d = os.path.dirname(DB)
    baks = sorted(
        [f for f in os.listdir(d) if f.startswith("cc-switch.db.bak-api-")],
        reverse=True,
    )
    for old in baks[KEEP_BACKUPS:]:
        try:
            os.remove(os.path.join(d, old))
        except OSError:
            pass
    return bak


def upsert(spec):
    pid = spec.get("id")
    if not pid:
        fail("缺少 id")
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    cur = db.cursor()
    cur.execute("SELECT id FROM providers WHERE id = ?", (pid,))
    exists = cur.fetchone() is not None

    sc = json.dumps(spec.get("settings_config") or {}, ensure_ascii=False)
    meta = json.dumps(spec.get("meta") or {
        "commonConfigEnabled": True,
        "endpointAutoSelect": True,
        "apiFormat": "anthropic",
        "apiKeyField": "ANTHROPIC_API_KEY",
    }, ensure_ascii=False)

    if exists:
        cur.execute(
            "UPDATE providers SET app_type=?, name=?, settings_config=?, notes=?, meta=?"
            " WHERE id=?",
            (spec.get("app_type"), spec.get("name"), sc, spec.get("notes"), meta, pid),
        )
    else:
        cur.execute("SELECT COALESCE(MAX(sort_index), 0) FROM providers")
        sort_index = (cur.fetchone()[0] or 0) + 1
        cur.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, website_url,"
            " category, created_at, sort_index, notes, icon, icon_color, meta,"
            " is_current, in_failover_queue, cost_multiplier, limit_daily_usd,"
            " limit_monthly_usd, provider_type)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                pid, spec.get("app_type"), spec.get("name"), sc, None, None,
                int(time.time() * 1000), sort_index, spec.get("notes"), None, None,
                meta, 0, 0, 1.0, None, None, None,
            ),
        )
    db.commit()
    db.close()
    return exists


def main():
    if not os.path.exists(DB):
        fail(f"找不到 cc-switch 数据库：{DB}")
    if len(sys.argv) < 2:
        fail("缺少参数")
    try:
        payload = json.loads(sys.argv[1])
    except Exception as e:
        fail(f"参数不是合法 JSON: {e}")

    action = payload.get("action", "upsert")
    if action == "list":
        db = sqlite3.connect(DB)
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute(
            "SELECT id, app_type, name, is_current FROM providers ORDER BY app_type, sort_index"
        ).fetchall()]
        db.close()
        print(json.dumps({"ok": True, "providers": rows}, ensure_ascii=False))
        return

    if action != "upsert":
        fail(f"未知 action: {action}")

    bak = backup()
    try:
        existed = upsert(payload.get("provider") or {})
    except Exception as e:
        fail(f"写库失败: {e}")
    print(json.dumps({
        "ok": True,
        "id": (payload.get("provider") or {}).get("id"),
        "updated": existed,
        "backup": os.path.basename(bak),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
