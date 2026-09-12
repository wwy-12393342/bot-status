# -*- coding: utf-8 -*-
"""积分系统公开网站（pythonanywhere 部署版）。

需要登录才能使用（账号密码由本地 AstrBot 站长创建并分发）：
- 登录后可查看自己的积分、上传图片、查看自己的图片、使用兑换码；
- 排行榜为公开只读，不展示具体用户ID。

数据通过受保护的同步接口与本地 AstrBot 积分插件双向同步：
- push：本地插件把用户/图片/账号数据推送到本站做快照；
- pull_actions / resolve：本站把用户发起的操作（兑换码/上传）交给本地插件处理。

部署到 pythonanywhere 时，WSGI 入口指向本文件的 ``app``。
"""
from __future__ import annotations

import hashlib
import hmac as hmac_mod
import json
import os
import secrets
import sqlite3
import time
import uuid

from flask import Flask, Response, jsonify, redirect, render_template, request, send_from_directory, session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "points_web.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")

# 网站版本号：与本地插件 version.py 的 PLUGIN_VERSION 必须完全一致，
# 不一致时网站会提示无法使用（防止新老版本混跑）。
WEB_VERSION = "5.21.39"

# 插件同步超时（秒）：超过该时长未收到插件推送（如同步功能被关闭/插件离线），
# 网站默认黑屏无法加载。可通过环境变量 POINTS_STALE_TIMEOUT 调整。
STALE_TIMEOUT = int(os.environ.get("POINTS_STALE_TIMEOUT", "180"))

# 同步 token：请与本地插件配置的 web_sync_token 保持一致
SYNC_TOKEN = os.environ.get("POINTS_SYNC_TOKEN", "")
# 会话密钥：优先环境变量；否则读取/生成持久化密钥文件，
# 保证 PythonAnywhere 多 worker / 重启后 session 签名一致（刷新不掉登录）。
SECRET_KEY = os.environ.get("POINTS_SECRET_KEY", "")
if not SECRET_KEY:
    _key_file = os.path.join(BASE_DIR, ".secret_key")
    try:
        if os.path.exists(_key_file):
            SECRET_KEY = open(_key_file, encoding="utf-8").read().strip()
        else:
            SECRET_KEY = secrets.token_hex(32)
            with open(_key_file, "w", encoding="utf-8") as f:
                f.write(SECRET_KEY)
    except OSError:
        # 站点目录不可写时退回固定默认值（多 worker 仍一致，但不建议生产用）
        SECRET_KEY = "points-web-fixed-secret-key-please-set-env"

app = Flask(__name__)
app.secret_key = SECRET_KEY or "points-web-fixed-secret-key"


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """为旧表补齐缺失的列（幂等迁移）。"""
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def _init_db() -> None:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    with _db() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, "
            "users TEXT NOT NULL, images TEXT NOT NULL, shop TEXT NOT NULL, "
            "bottles TEXT NOT NULL, updated_at REAL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, "
            "uid TEXT NOT NULL, password_hash TEXT NOT NULL, password_plain TEXT DEFAULT '', "
            "enabled INTEGER DEFAULT 1, is_admin INTEGER DEFAULT 0)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS pending_actions (id TEXT PRIMARY KEY, "
            "type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT DEFAULT 'pending', "
            "result TEXT DEFAULT '', created_at REAL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, "
            "owner_uid TEXT, filename TEXT, public_url TEXT, size INTEGER, created_at REAL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY, "
            "content TEXT NOT NULL DEFAULT '', author TEXT DEFAULT '', updated_at REAL)"
        )
        # 聊天室（独立，不跨端同步）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "uid TEXT NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, created_at REAL)"
        )
        # 留言板（数据仅存服务器，不存本地插件）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS board_messages (id TEXT PRIMARY KEY, "
            "author_uid TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL, "
            "pinned INTEGER DEFAULT 0, likes TEXT NOT NULL DEFAULT '[]', created_at REAL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS board_replies (id TEXT PRIMARY KEY, "
            "message_id TEXT NOT NULL, author_uid TEXT NOT NULL, author_name TEXT NOT NULL, "
            "content TEXT NOT NULL, created_at REAL)"
        )
        # 站内邮箱（QQ号@qq.com，可附积分）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mail_messages (id TEXT PRIMARY KEY, "
            "from_uid TEXT NOT NULL, from_name TEXT NOT NULL, to_uid TEXT NOT NULL, "
            "to_name TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, "
            "points INTEGER DEFAULT 0, claimed INTEGER DEFAULT 0, read INTEGER DEFAULT 0, "
            "created_at REAL)"
        )
        # 每日任务完成状态
        conn.execute(
            "CREATE TABLE IF NOT EXISTS daily_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "uid TEXT NOT NULL, date TEXT NOT NULL, sign_done INTEGER DEFAULT 0, "
            "chat_done INTEGER DEFAULT 0, like_done INTEGER DEFAULT 0, redeem_done INTEGER DEFAULT 0, "
            "claimed_sign INTEGER DEFAULT 0, claimed_chat INTEGER DEFAULT 0, "
            "claimed_like INTEGER DEFAULT 0, claimed_redeem INTEGER DEFAULT 0)"
        )
        # 网站生成的兑换码（展示用，实际兑换在插件）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS redeem_web (code TEXT PRIMARY KEY, "
            "points INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created_at REAL)"
        )
        # 用户反馈
        conn.execute(
            "CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, "
            "uid TEXT NOT NULL, username TEXT NOT NULL, content TEXT NOT NULL, "
            "status INTEGER DEFAULT 0, reply TEXT DEFAULT '', created_at REAL)"
        )
        # 五子棋（联机对战，数据仅存服务器，5秒轮询）
        conn.execute(
            "CREATE TABLE IF NOT EXISTS gomoku_games (game_id TEXT PRIMARY KEY, "
            "board TEXT NOT NULL DEFAULT '', "
            "player_black_uid TEXT NOT NULL DEFAULT '', player_black_name TEXT NOT NULL DEFAULT '', "
            "player_white_uid TEXT NOT NULL DEFAULT '', player_white_name TEXT NOT NULL DEFAULT '', "
            "current_turn INTEGER DEFAULT 1, status TEXT DEFAULT 'waiting', "
            "winner INTEGER DEFAULT 0, resign_by TEXT DEFAULT '', chat TEXT NOT NULL DEFAULT '[]', "
            "last_move TEXT DEFAULT '', created_at REAL, updated_at REAL)"
        )
        # 旧库迁移：补齐新列
        _ensure_column(conn, "snapshot", "lottery", "TEXT")
        _ensure_column(conn, "snapshot", "split", "TEXT")
        _ensure_column(conn, "snapshot", "version", "TEXT DEFAULT ''")
        _ensure_column(conn, "snapshot", "redpackets", "TEXT")
        _ensure_column(conn, "snapshot", "auction", "TEXT")
        _ensure_column(conn, "snapshot", "web_config", "TEXT")
        _ensure_column(conn, "accounts", "bio", "TEXT DEFAULT ''")
        _ensure_column(conn, "accounts", "password_plain", "TEXT DEFAULT ''")
        _ensure_column(conn, "accounts", "uid_code", "TEXT DEFAULT ''")
        _ensure_column(conn, "snapshot", "bind_requests", "TEXT")
        _ensure_column(conn, "chat_messages", "reply_to_id", "INTEGER DEFAULT 0")


def _load_snapshot() -> dict:
    with _db() as conn:
        row = conn.execute("SELECT * FROM snapshot LIMIT 1").fetchone()
    if not row:
        return {
            "users": [],
            "images": [],
            "shop": {},
            "bottles": [],
            "lottery": {},
            "split": {},
            "redpackets": {},
            "auction": {},
            "web_config": {},
            "version": "",
            "bind_requests": [],
            "updated_at": 0,
        }
    return {
        "users": json.loads(row["users"] or "[]"),
        "images": json.loads(row["images"] or "[]"),
        "shop": json.loads(row["shop"] or "{}"),
        "bottles": json.loads(row["bottles"] or "[]"),
        "lottery": json.loads(row["lottery"] or "{}"),
        "split": json.loads(row["split"] or "{}"),
        "redpackets": json.loads(row["redpackets"] or "{}"),
        "auction": json.loads(row["auction"] or "{}"),
        "web_config": json.loads(row["web_config"] or "{}"),
        "bind_requests": json.loads(
            (row["bind_requests"] if "bind_requests" in row.keys() else "") or "[]"
        ),
        "version": str(row["version"] or ""),
        "updated_at": row["updated_at"] or 0,
    }


def _save_snapshot(users: list, images: list, shop=None, bottles=None, lottery=None, split=None, redpackets=None, auction=None, web_config=None, version="", bind_requests=None) -> None:
    with _db() as conn:
        conn.execute("DELETE FROM snapshot")
        conn.execute(
            "INSERT INTO snapshot (id, users, images, shop, bottles, lottery, split, redpackets, auction, web_config, version, updated_at, bind_requests) "
            "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                json.dumps(users, ensure_ascii=False),
                json.dumps(images, ensure_ascii=False),
                json.dumps(shop or {}, ensure_ascii=False),
                json.dumps(bottles or [], ensure_ascii=False),
                json.dumps(lottery or {}, ensure_ascii=False),
                json.dumps(split or {}, ensure_ascii=False),
                json.dumps(redpackets or {}, ensure_ascii=False),
                json.dumps(auction or {}, ensure_ascii=False),
                json.dumps(web_config or {}, ensure_ascii=False),
                str(version or ""),
                time.time(),
                json.dumps(bind_requests or [], ensure_ascii=False),
            ),
        )


def _check_sync_token() -> bool:
    if not SYNC_TOKEN:
        return True  # 未配置 token 时放行（仅用于开发）
    auth = request.headers.get("Authorization", "")
    return auth == f"Bearer {SYNC_TOKEN}"


# ---------- 密码哈希（与本地插件一致） ----------

_ITERATIONS = 200_000


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return f"pbkdf2_sha256${_ITERATIONS}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt_hex, digest_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
        return hmac_mod.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def _sync_accounts(accounts: list) -> None:
    with _db() as conn:
        conn.execute("DELETE FROM accounts")
        for acc in accounts:
            conn.execute(
                "INSERT OR REPLACE INTO accounts "
                "(username, uid, uid_code, password_hash, password_plain, enabled, is_admin, bio) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(acc.get("username", "")),
                    str(acc.get("uid", "")),
                    str(acc.get("uid_code", "")),
                    str(acc.get("password_hash", "")),
                    str(acc.get("password_plain", "") or ""),
                    1 if acc.get("enabled", True) else 0,
                    1 if acc.get("is_admin", False) else 0,
                    str(acc.get("bio", "") or ""),
                ),
            )


def _get_account(username: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM accounts WHERE username=?", (username,)
        ).fetchone()
    if not row:
        return None
    return {
        "username": row["username"],
        "uid": row["uid"],
        "uid_code": (row["uid_code"] if "uid_code" in row.keys() else "") or "",
        "password_hash": row["password_hash"],
        "password_plain": row["password_plain"] if "password_plain" in row.keys() else "",
        "enabled": bool(row["enabled"]),
        "is_admin": bool(row["is_admin"]),
        "bio": row["bio"] if "bio" in row.keys() else "",
    }


def _display_name(user: dict | None) -> str:
    """显示名回退链：积分库昵称 → 网站账号用户名 → 用户ID。

    修复「账号匿名」：web 注册用户 user_name 为空时，回退到 accounts.username，
    避免排行榜等地方显示为「匿名」或空白。
    """
    if not user:
        return "未知用户"
    name = str(user.get("user_name") or "").strip()
    if name:
        return name
    uid = str(user.get("user_id") or "").strip()
    acc = _get_account_by_uid(uid)
    if acc:
        return acc["username"]
    return uid or "未知用户"


def _get_account_by_uid_code(uid_code: str) -> dict | None:
    code = str(uid_code or "").strip()
    if not code:
        return None
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM accounts WHERE uid_code=?", (code,)
        ).fetchone()
    if not row:
        return None
    return {
        "username": row["username"],
        "uid": row["uid"],
        "uid_code": (row["uid_code"] if "uid_code" in row.keys() else "") or "",
        "password_hash": row["password_hash"],
        "password_plain": row["password_plain"] if "password_plain" in row.keys() else "",
        "enabled": bool(row["enabled"]),
        "is_admin": bool(row["is_admin"]),
        "bio": row["bio"] if "bio" in row.keys() else "",
    }


def _get_account_by_uid(uid: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM accounts WHERE uid=?", (uid,)
        ).fetchone()
    if not row:
        return None
    return {
        "username": row["username"],
        "uid": row["uid"],
        "password_hash": row["password_hash"],
        "password_plain": row["password_plain"] if "password_plain" in row.keys() else "",
        "enabled": bool(row["enabled"]),
        "is_admin": bool(row["is_admin"]),
        "bio": row["bio"] if "bio" in row.keys() else "",
    }


# ---------- 登录 / 鉴权 ----------


def _current_uid() -> str | None:
    username = session.get("username")
    if not username:
        return None
    acc = _get_account(username)
    if acc and acc["enabled"]:
        return acc["uid"]
    # 用户名已变更（用户改名后插件推送了新用户名，旧会话用户名失效）：
    # 用会话中的 uid 重新定位账号，并刷新会话用户名，保证改用户名后不掉登录。
    session_uid = session.get("uid")
    if session_uid:
        acc = _get_account_by_uid(session_uid)
        if acc and acc["enabled"]:
            session["username"] = acc["username"]
            return acc["uid"]
    return None


def _current_is_admin() -> bool:
    username = session.get("username")
    if not username:
        return False
    acc = _get_account(username)
    return bool(acc and acc.get("is_admin"))


@app.route("/api/login", methods=["POST"])
def api_login():
    body = request.get_json(force=True, silent=True) or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()
    acc = _get_account(username)
    if not acc or not acc["enabled"] or not _verify_password(password, acc["password_hash"]):
        return jsonify({"status": "error", "message": "用户名或密码错误"}), 401
    session["username"] = acc["username"]
    session["uid"] = acc["uid"]
    return jsonify(
        {
            "status": "ok",
            "data": {
                "username": acc["username"],
                "uid": acc["uid"],
                "is_admin": acc.get("is_admin", False),
            },
        }
    )


@app.route("/api/register", methods=["POST"])
def api_register():
    """注册：填写 QQ号 + cookieQQ 验证码 + 用户名 + 密码。提交后由本地插件验证并创建。"""
    body = request.get_json(force=True, silent=True) or {}
    uid = str(body.get("uid", "")).strip()
    verify_id = str(body.get("verify_id", "")).strip()
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", "")).strip()
    if not uid or not verify_id or not username or not password:
        return jsonify({"status": "error", "message": "请填写QQ号、cookieQQ验证码、用户名和密码"}), 400
    # 快速预检：用户名是否已存在（区分「自己的账号」还是「他人占用」）
    existing = _get_account(username)
    if existing is not None:
        if str(existing.get("uid", "")) == uid:
            return jsonify(
                {"status": "error", "message": "该用户名已是您注册的账号，请直接登录；若忘记密码请用「找回密码」（填QQ号校验ID）重置"}
            ), 400
        return jsonify(
            {"status": "error", "message": "该用户名已被他人注册，请换一个用户名"}
        ), 400
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'register', ?, 'pending', ?)",
            (
                action_id,
                json.dumps(
                    {"uid": uid, "verify_id": verify_id, "username": username, "password": password},
                    ensure_ascii=False,
                ),
                time.time(),
            ),
        )
    return jsonify(
        {
            "status": "ok",
            "message": "注册申请已提交，校验通过后即可登录（约数秒）。登录后可在个人页看到你的永久 UID",
            "data": {"id": action_id},
        }
    )


@app.route("/api/me/bind_requests", methods=["GET"])
def api_bind_requests():
    """列出「目标 UID = 我」的绑定请求。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    acc = _get_account(session.get("username"))
    code = str((acc or {}).get("uid_code", "") or "").strip()
    if not code:
        return jsonify({"status": "ok", "data": {"items": []}})
    snap = _load_snapshot()
    items = []
    for r in snap.get("bind_requests") or []:
        if str(r.get("target_uid", "")).strip() != code:
            continue
        items.append(
            {
                "key": r.get("key", ""),
                "platform": r.get("platform", ""),
                "user_id": r.get("user_id", ""),
                "user_name": r.get("user_name", ""),
                "status": r.get("status", ""),
                "updated_at": r.get("updated_at", 0),
            }
        )
    items.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return jsonify({"status": "ok", "data": {"items": items}})


def _submit_bind_action(kind: str):
    """把「确认/拒绝绑定」写进 pending_actions，由本地插件处理。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    acc = _get_account(session.get("username"))
    code = str((acc or {}).get("uid_code", "") or "").strip()
    body = request.get_json(force=True, silent=True) or {}
    key = str(body.get("key", "")).strip()
    if not code or not key:
        return jsonify({"status": "error", "message": "参数缺失"}), 400
    snap = _load_snapshot()
    target = next(
        (r for r in (snap.get("bind_requests") or []) if str(r.get("key", "")) == key),
        None,
    )
    if target is None or str(target.get("target_uid", "")).strip() != code:
        return jsonify({"status": "error", "message": "找不到该请求，或它不属于你的 UID"}), 404
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, ?, ?, 'pending', ?)",
            (
                action_id,
                kind,
                json.dumps({"key": key, "uid_code": code}, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {"status": "ok", "message": "已提交，稍后生效（约数秒）", "data": {"id": action_id}}
    )


@app.route("/api/me/bind/confirm", methods=["POST"])
def api_bind_confirm():
    return _submit_bind_action("bind_confirm")


@app.route("/api/me/bind/reject", methods=["POST"])
def api_bind_reject():
    return _submit_bind_action("bind_reject")


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"status": "ok"})


@app.route("/api/me", methods=["GET"])
def api_me():
    uid = _current_uid()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    username = session.get("username")
    acc = _get_account(username) if username else None
    return jsonify(
        {
            "status": "ok",
            "data": {
                "username": username,
                "uid": uid,
                "uid_code": (acc.get("uid_code") or "") if acc else "",
                "is_admin": _current_is_admin(),
                "bio": (acc.get("bio") or "") if acc else "",
            },
        }
    )


def _current_data_uid() -> str | None:
    """取用户数据用的标识：优先【永久 UID(uid_code)】，退回原 uid。

    积分/图片/兑换等数据现在都记在 UID 名下（绑定系统统一口径），
    所以这里必须用 uid_code，否则「我的积分」会查不到。
    """
    username = session.get("username")
    if not username:
        return None
    acc = _get_account(username)
    if not acc or not acc["enabled"]:
        return None
    return str(acc.get("uid_code") or acc.get("uid") or "").strip() or None


def _require_login():
    uid = _current_data_uid()
    if not uid:
        return None
    return uid


def _submit_action(action_type: str, payload: dict) -> tuple[dict, int]:
    """插入一条待处理请求（由本地插件执行），返回 (响应, http状态码)。"""
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, ?, ?, 'pending', ?)",
            (
                action_id,
                action_type,
                json.dumps(payload, ensure_ascii=False),
                time.time(),
            ),
        )
    return (
        jsonify(
            {
                "status": "ok",
                "message": "已提交，结果将在同步后生效",
                "data": {"id": action_id},
            }
        ),
        200,
    )


# ---------- 同步接口（仅本地插件调用） ----------


@app.route("/api/sync/push", methods=["POST"])
def sync_push():
    if not _check_sync_token():
        return jsonify({"status": "error", "message": "未授权"}), 401
    body = request.get_json(force=True, silent=True) or {}
    users = body.get("users") or []
    images = body.get("images") or []
    accounts = body.get("accounts") or []
    shop = body.get("shop") or {}
    bottles = body.get("bottles") or []
    lottery = body.get("lottery") or {}
    split = body.get("split") or {}
    redpackets = body.get("redpackets") or {}
    auction = body.get("auction") or {}
    web_config = body.get("web_config") or {}
    version = body.get("version") or ""
    bind_requests = body.get("bind_requests") or []
    _save_snapshot(
        users, images, shop=shop, bottles=bottles, lottery=lottery, split=split,
        redpackets=redpackets, auction=auction, web_config=web_config, version=version,
        bind_requests=bind_requests,
    )
    if accounts:
        _sync_accounts(accounts)
    return jsonify({"status": "ok"})


@app.route("/api/sync/pull_actions", methods=["GET"])
def sync_pull_actions():
    if not _check_sync_token():
        return jsonify({"status": "error", "message": "未授权"}), 401
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM pending_actions WHERE status='pending' ORDER BY created_at"
        ).fetchall()
    items = []
    for row in rows:
        item = {
            "id": row["id"],
            "type": row["type"],
            "payload": json.loads(row["payload"] or "{}"),
        }
        if row["type"] == "upload":
            item["upload"] = _upload_meta(row["payload"])
        items.append(item)
    return jsonify({"status": "ok", "actions": items})


def _upload_meta(payload: dict | str) -> dict | None:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    upload_id = payload.get("upload_id", "")
    if not upload_id:
        return None
    with _db() as conn:
        row = conn.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "owner_uid": row["owner_uid"],
        "filename": row["filename"],
        "public_url": row["public_url"],
        "size": row["size"],
        "created_at": row["created_at"],
    }


@app.route("/api/sync/resolve", methods=["POST"])
def sync_resolve():
    if not _check_sync_token():
        return jsonify({"status": "error", "message": "未授权"}), 401
    body = request.get_json(force=True, silent=True) or {}
    action_id = body.get("id", "")
    status = body.get("status", "failed")
    result = body.get("result", "")
    with _db() as conn:
        conn.execute(
            "UPDATE pending_actions SET status=?, result=? WHERE id=?",
            (status, json.dumps(result, ensure_ascii=False), action_id),
        )
    return jsonify({"status": "ok"})


# ---------- 公开只读：排行榜（不展示用户ID） ----------


@app.route("/api/leaderboard", methods=["GET"])
def api_leaderboard():
    """排行榜：支持总榜 / 本周 / 本月（period=all|week|month）。"""
    snap = _load_snapshot()
    period = str(request.args.get("period", "all")).strip()
    users = snap["users"]
    now = time.time()
    day_secs = 86400
    # 本周起点（周一）
    lt = time.localtime()
    week_start = now - lt.tm_wday * day_secs
    # 本月起点
    month_start = time.mktime((lt.tm_year, lt.tm_mon, 1, 0, 0, 0, 0, 0, -1))
    rows = []
    for u in users:
        points = int(u.get("points", 0) or 0)
        name = _display_name(u)
        if period in ("week", "month"):
            cutoff = week_start if period == "week" else month_start
            delta = 0
            for e in u.get("ledger") or []:
                if float(e.get("t", 0) or 0) >= cutoff:
                    delta += int(e.get("delta", 0) or 0)
            points = max(0, delta)
        rows.append({"user_id": str(u.get("user_id", "")), "name": name, "points": points})
    rows.sort(key=lambda x: x["points"], reverse=True)
    limit = int(request.args.get("limit", 100))
    rows = rows[: max(1, min(limit, 500))]
    items = [
        {"rank": idx + 1, "name": r["name"], "points": r["points"]}
        for idx, r in enumerate(rows)
    ]
    return jsonify({"status": "ok", "data": {"items": items}})


# ---------- 登录后接口 ----------


@app.route("/api/me/points", methods=["GET"])
def api_me_points():
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    for u in snap["users"]:
        if str(u.get("user_id", "")) == uid:
            return jsonify({"status": "ok", "data": {"found": True, "user": u}})
    return jsonify({"status": "ok", "data": {"found": False}})


@app.route("/api/me/sign_in/status", methods=["GET"])
def api_me_sign_in_status():
    """返回当月签到日历：本月每天是否已签到。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    user = None
    for u in snap["users"]:
        if str(u.get("user_id", "")) == uid:
            user = u
            break
    if not user:
        return jsonify(
            {
                "status": "ok",
                "data": {"found": False, "calendar": _build_month_calendar([])},
            }
        )
    signed_days = user.get("sign_in_days") or []
    return jsonify(
        {
            "status": "ok",
            "data": {
                "found": True,
                "calendar": _build_month_calendar(signed_days),
                "today": time.strftime("%Y-%m-%d"),
                "last_sign_in": user.get("last_sign_in", ""),
                "streak": user.get("sign_in_streak", 0),
            },
        }
    )


def _build_month_calendar(signed_days: list) -> dict:
    """生成本月日历：weekday 0=周一，days 每项 {day, signed}。"""
    now = time.localtime()
    year, month = now.tm_year, now.tm_mon
    first = time.mktime((year, month, 1, 0, 0, 0, 0, 0, -1))
    first_weekday = (time.localtime(first).tm_wday + 1) % 7  # 周一=0
    month_days = 31 if month in (1, 3, 5, 7, 8, 10, 12) else 30
    if month == 2:
        leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
        month_days = 29 if leap else 28
    signed_set = set(signed_days or [])
    days = []
    for day in range(1, month_days + 1):
        date_str = f"{year:04d}-{month:02d}-{day:02d}"
        days.append({"day": day, "signed": date_str in signed_set})
    return {
        "year": year,
        "month": month,
        "first_weekday": first_weekday,
        "days": days,
        "today": now.tm_mday,
    }


@app.route("/api/sign_in", methods=["POST"])
def api_sign_in():
    """提交签到请求（由本地插件真正执行）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'sign_in', ?, 'pending', ?)",
            (
                action_id,
                json.dumps({"uid": uid}, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {
            "status": "ok",
            "message": "签到请求已提交，结果将在同步后更新",
            "data": {"id": action_id},
        }
    )


@app.route("/api/me/sign_in_result", methods=["GET"])
def api_me_sign_in_result():
    """查询当前用户最近一次签到结果。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM pending_actions WHERE type='sign_in' "
            "ORDER BY created_at DESC LIMIT 5"
        ).fetchall()
    items = []
    for row in rows:
        payload = json.loads(row["payload"] or "{}")
        if str(payload.get("uid", "")) == uid:
            result = json.loads(row["result"] or "{}")
            items.append(
                {
                    "status": row["status"],
                    "message": result.get("message", ""),
                    "reward": result.get("reward", 0),
                    "created_at": row["created_at"],
                }
            )
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/me/images", methods=["GET"])
def api_me_images():
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    images = [
        i
        for i in snap["images"]
        if str(i.get("owner_user_id", "")) == uid and i.get("url")
    ]
    images.sort(key=lambda i: i.get("created_at", 0) or 0, reverse=True)
    return jsonify(
        {"status": "ok", "data": {"total": len(images), "items": images}}
    )


@app.route("/api/me/redeem_result", methods=["GET"])
def api_me_redeem_result():
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM pending_actions WHERE type='redeem' "
            "ORDER BY created_at DESC LIMIT 20"
        ).fetchall()
    items = []
    for row in rows:
        payload = json.loads(row["payload"] or "{}")
        if str(payload.get("uid", "")) == uid:
            result = json.loads(row["result"] or "{}")
            items.append(
                {
                    "code": payload.get("code", ""),
                    "status": row["status"],
                    "message": result.get("message", ""),
                    "points": result.get("points", 0),
                    "created_at": row["created_at"],
                }
            )
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/me/profile", methods=["POST"])
def api_me_profile():
    """修改个人资料：action = rename|password。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    username = session.get("username")
    action = str(body.get("action", "")).strip()
    verify_id = str(body.get("verify_id", "")).strip()
    payload = {"username": username, "action": action, "verify_id": verify_id}
    if action == "rename":
        payload["new_username"] = str(body.get("new_username", "")).strip()
    elif action == "password":
        payload["new_password"] = str(body.get("new_password", "")).strip()
    else:
        return jsonify({"status": "error", "message": "不支持的修改类型"}), 400
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'profile', ?, 'pending', ?)",
            (
                action_id,
                json.dumps(payload, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {
            "status": "ok",
            "message": "修改已提交，稍后生效",
            "data": {"id": action_id},
        }
    )


@app.route("/api/me/random_image", methods=["GET"])
def api_me_random_image():
    """随机展示自己上传的一张图片。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    images = [
        i for i in snap["images"] if str(i.get("owner_user_id", "")) == uid and i.get("url")
    ]
    if not images:
        return jsonify({"status": "ok", "data": {"found": False}})
    chosen = images[int(time.time()) % len(images)]
    return jsonify({"status": "ok", "data": {"found": True, "image": chosen}})


# ---------- 照片墙 ----------


@app.route("/api/wall", methods=["GET"])
def api_wall():
    """照片墙：展示全部图片（分页，支持按最新/点赞排序）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    images = [i for i in snap["images"] if i.get("url")]
    sort_by = str(request.args.get("sort", "latest"))
    page = max(1, int(request.args.get("page", 1) or 1))
    size = max(1, min(int(request.args.get("size", 24) or 24), 100))
    if sort_by == "likes":
        images.sort(
            key=lambda i: int(i.get("like_count", 0) or 0), reverse=True
        )
    else:
        images.sort(key=lambda i: i.get("created_at", 0) or 0, reverse=True)
    total = len(images)
    items = images[(page - 1) * size : page * size]
    out = []
    for img in items:
        liked_by = [str(x) for x in (img.get("likes") or [])]
        fav_by = [str(x) for x in (img.get("favorites") or [])]
        item = dict(img)
        item["liked_by_me"] = uid in liked_by
        item["favorited_by_me"] = uid in fav_by
        item["mine"] = str(img.get("owner_user_id", "")) == uid
        out.append(item)
    return jsonify(
        {
            "status": "ok",
            "data": {
                "items": out,
                "total": total,
                "page": page,
                "size": size,
                "pages": max(1, (total + size - 1) // size),
            },
        }
    )


@app.route("/api/wall/like", methods=["POST"])
def api_wall_like():
    """照片墙点赞/取消点赞（本地插件切换，下一轮同步生效）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    image_id = str(body.get("image_id", "")).strip()
    if not image_id:
        return jsonify({"status": "error", "message": "缺少图片ID"}), 400
    snap = _load_snapshot()
    image = next(
        (i for i in snap["images"] if str(i.get("id", "")) == image_id), None
    )
    if image is None:
        return jsonify({"status": "error", "message": "图片不存在"}), 404
    resp, _ = _submit_action("image_like", {"uid": uid, "image_id": image_id})
    return resp


@app.route("/api/wall/favorite", methods=["POST"])
def api_wall_favorite():
    """照片墙收藏/取消收藏（本地插件切换，下一轮同步生效）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    image_id = str(body.get("image_id", "")).strip()
    if not image_id:
        return jsonify({"status": "error", "message": "缺少图片ID"}), 400
    snap = _load_snapshot()
    image = next(
        (i for i in snap["images"] if str(i.get("id", "")) == image_id), None
    )
    if image is None:
        return jsonify({"status": "error", "message": "图片不存在"}), 404
    resp, _ = _submit_action("image_favorite", {"uid": uid, "image_id": image_id})
    return resp


@app.route("/api/me/favorites", methods=["GET"])
def api_me_favorites():
    """我收藏的图片。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    images = [
        i for i in snap["images"]
        if i.get("url") and uid in [str(x) for x in (i.get("favorites") or [])]
    ]
    images.sort(key=lambda i: i.get("created_at", 0) or 0, reverse=True)
    return jsonify({"status": "ok", "data": {"total": len(images), "items": images}})


@app.route("/api/tip", methods=["POST"])
def api_tip():
    """赞赏图片：给图片作者打赏积分。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    image_id = str(body.get("image_id", "")).strip()
    try:
        amount = int(body.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0
    if not image_id:
        return jsonify({"status": "error", "message": "缺少图片ID"}), 400
    if amount < 1:
        return jsonify({"status": "error", "message": "赞赏金额需大于 0"}), 400
    if amount > 1_000_000:
        return jsonify({"status": "error", "message": "金额过大"}), 400
    snap = _load_snapshot()
    image = next(
        (i for i in snap["images"] if str(i.get("id", "")) == image_id), None
    )
    if image is None:
        return jsonify({"status": "error", "message": "图片不存在"}), 404
    if str(image.get("owner_user_id", "")) == uid:
        return jsonify({"status": "error", "message": "不能给自己的图片赞赏"}), 400
    resp, _ = _submit_action(
        "image_tip", {"uid": uid, "image_id": image_id, "amount": amount}
    )
    return resp


@app.route("/api/transfer", methods=["POST"])
def api_transfer():
    """积分转账：给指定用户ID转账（需校验ID）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    target_uid = str(body.get("target_uid", "")).strip()
    verify_id = str(body.get("verify_id", "")).strip()
    try:
        amount = int(body.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0
    if not target_uid:
        return jsonify({"status": "error", "message": "请填写目标用户ID"}), 400
    if amount < 1:
        return jsonify({"status": "error", "message": "转账金额需大于 0"}), 400
    if not verify_id:
        return jsonify({"status": "error", "message": "请先私聊机器人获取校验ID"}), 400
    resp, _ = _submit_action(
        "transfer",
        {"uid": uid, "target_uid": target_uid, "amount": amount, "verify_id": verify_id},
    )
    return resp


# ---------- 抽奖 ----------


@app.route("/api/lottery/info", methods=["GET"])
def api_lottery_info():
    """抽奖信息：奖品表、单次消耗、近期中奖记录。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    lottery = snap.get("lottery") or {}
    prizes = lottery.get("prizes") or []
    cost = int(lottery.get("cost") or 10)
    log = lottery.get("log") or []
    user = None
    for u in snap["users"]:
        if str(u.get("user_id", "")) == uid:
            user = u
            break
    my_ledger = []
    if user:
        for entry in reversed(user.get("ledger") or []):
            if entry.get("reason") in ("抽奖", "抽奖中奖"):
                my_ledger.append(entry)
    return jsonify(
        {
            "status": "ok",
            "data": {
                "cost": cost,
                "prizes": prizes,
                "log": log[:20],
                "my_spins": my_ledger[:30],
                "balance": int(user.get("points", 0)) if user else 0,
                "found": user is not None,
            },
        }
    )


@app.route("/api/lottery", methods=["POST"])
def api_lottery():
    """发起抽奖。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    resp, _ = _submit_action("lottery", {"uid": uid})
    return resp


# ---------- 瓜分池 ----------


@app.route("/api/split/info", methods=["GET"])
def api_split_info():
    """瓜分池状态：余额、单次份额范围、我的瓜分记录。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    split = snap.get("split") or {}
    records = split.get("records") or []
    grabbed = any(str(r.get("user_id", "")) == uid for r in records)
    return jsonify(
        {
            "status": "ok",
            "data": {
                "balance": int(split.get("balance", 0) or 0),
                "total": int(split.get("total", 0) or 0),
                "min_share": int(split.get("min_share", 1) or 1),
                "max_share": int(split.get("max_share", 50) or 50),
                "round": int(split.get("round", 0) or 0),
                "finished": bool(split.get("finished", False)),
                "grabbed": grabbed,
                "records": records,
            },
        }
    )


@app.route("/api/split", methods=["POST"])
def api_split():
    """用户瓜分瓜分池。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    split = snap.get("split") or {}
    records = split.get("records") or []
    if any(str(r.get("user_id", "")) == uid for r in records):
        return jsonify({"status": "error", "message": "您已参与本轮瓜分"}), 400
    if int(split.get("balance", 0) or 0) <= 0:
        return jsonify({"status": "error", "message": "瓜分池已空，请等待管理员补充"}), 400
    resp, _ = _submit_action("split", {"uid": uid})
    return resp


# ---------- 聊天室（独立，数据存本站，3秒轮询） ----------


@app.route("/api/chat/messages", methods=["GET"])
def api_chat_messages():
    """拉取聊天室消息（增量轮询，after_id 之后的新消息）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    try:
        after_id = int(request.args.get("after_id", 0) or 0)
    except (TypeError, ValueError):
        after_id = 0
    try:
        limit = int(request.args.get("limit", 50) or 50)
    except (TypeError, ValueError):
        limit = 50
    limit = max(1, min(limit, 200))
    with _db() as conn:
        if after_id > 0:
            rows = conn.execute(
                "SELECT * FROM chat_messages WHERE id>? ORDER BY id ASC LIMIT ?",
                (after_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            rows = list(reversed(rows))
    reply_ids = [r["reply_to_id"] for r in rows if r["reply_to_id"]]
    reply_map = {}
    if reply_ids:
        with _db() as conn:
            reply_rows = conn.execute(
                f"SELECT id, uid, username, content FROM chat_messages WHERE id IN ({','.join('?' for _ in reply_ids)})",
                tuple(reply_ids),
            ).fetchall()
        reply_map = {row["id"]: dict(row) for row in reply_rows}
    # 头像用的 QQ：uid(永久UID) -> 账号 -> 注册时的QQ
    qq_map: dict = {}
    for row in rows:
        code = str(row["uid"] or "").strip()
        if code and code not in qq_map:
            _acc = _get_account_by_uid_code(code)
            qq_map[code] = str((_acc or {}).get("uid", "") or "")

    items = []
    for row in rows:
        _code = str(row["uid"] or "").strip()
        item = {
            "id": row["id"],
            "uid": row["uid"],
            "username": row["username"],
            "content": row["content"],
            "qq": qq_map.get(_code, ""),
            "created_at": row["created_at"],
        }
        rid = row["reply_to_id"] or 0
        if rid and rid in reply_map:
            r = reply_map[rid]
            item["reply"] = {
                "id": r["id"],
                "username": r["username"],
                "content": r["content"][:100],
            }
        items.append(item)
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/chat/send", methods=["POST"])
def api_chat_send():
    """发送一条聊天室消息（支持 @回复 reply_to_id）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    content = str(body.get("content", "")).strip()[:500]
    if not content:
        return jsonify({"status": "error", "message": "消息内容不能为空"}), 400
    try:
        reply_to_id = int(body.get("reply_to_id", 0) or 0)
    except (TypeError, ValueError):
        reply_to_id = 0
    username = session.get("username") or ""
    with _db() as conn:
        if reply_to_id > 0:
            reply_row = conn.execute(
                "SELECT id FROM chat_messages WHERE id=?", (reply_to_id,)
            ).fetchone()
            if reply_row is None:
                return jsonify({"status": "error", "message": "回复的消息不存在"}), 404
        conn.execute(
            "INSERT INTO chat_messages (uid, username, content, reply_to_id, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (uid, username, content, reply_to_id, time.time()),
        )
        # 清理：只保留最近 1000 条
        conn.execute(
            "DELETE FROM chat_messages WHERE id NOT IN "
            "(SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1000)"
        )
    return jsonify({"status": "ok", "message": "已发送"})


# ---------- 红包（与本地插件互通） ----------


@app.route("/api/redpackets", methods=["GET"])
def api_redpackets():
    """查看当前有效红包列表（数据来自插件快照）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    rp = snap.get("redpackets") or {}
    packets = rp.get("packets") or []
    items = []
    for p in packets:
        claims = p.get("claims") or []
        grabbed = any(str(c.get("user_id", "")) == uid for c in claims)
        mine = str(p.get("sender_uid", "")) == uid
        items.append(
            {
                "id": p.get("id", ""),
                "sender_uid": p.get("sender_uid", ""),
                "sender_name": p.get("sender_name", "") or p.get("sender_uid", ""),
                "total": int(p.get("total", 0) or 0),
                "count": int(p.get("count", 0) or 0),
                "mode": p.get("mode", "random"),
                "remaining": int(p.get("remaining", 0) or 0),
                "claims": claims,
                "created_at": p.get("created_at", 0),
                "expires_at": p.get("expires_at", 0),
                "grabbed": grabbed,
                "mine": mine,
            }
        )
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/redpackets/send", methods=["POST"])
def api_redpackets_send():
    """发红包：扣积分、生成红包（由本地插件执行）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    try:
        total = int(body.get("total", 0))
    except (TypeError, ValueError):
        total = 0
    try:
        count = int(body.get("count", 0))
    except (TypeError, ValueError):
        count = 0
    mode = str(body.get("mode", "")).strip() or "random"
    if total < 1:
        return jsonify({"status": "error", "message": "红包总金额需大于 0"}), 400
    if count < 1:
        return jsonify({"status": "error", "message": "红包份数需大于 0"}), 400
    if count > 100:
        return jsonify({"status": "error", "message": "红包份数最多 100 份"}), 400
    if total < count:
        return jsonify({"status": "error", "message": "红包总金额不能少于份数"}), 400
    if mode not in ("random", "fixed"):
        mode = "random"
    resp, _ = _submit_action(
        "redpacket_send", {"uid": uid, "total": total, "count": count, "mode": mode}
    )
    return resp


@app.route("/api/redpackets/grab", methods=["POST"])
def api_redpackets_grab():
    """抢红包：点击即抢，无需校验ID（由本地插件执行）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    packet_id = str(body.get("packet_id", "")).strip()
    if not packet_id:
        return jsonify({"status": "error", "message": "缺少红包ID"}), 400
    snap = _load_snapshot()
    rp = snap.get("redpackets") or {}
    packets = rp.get("packets") or []
    packet = next((p for p in packets if str(p.get("id", "")) == packet_id), None)
    if packet is None:
        return jsonify({"status": "error", "message": "红包不存在或已过期"}), 404
    if str(packet.get("sender_uid", "")) == uid:
        return jsonify({"status": "error", "message": "不能抢自己发的红包"}), 400
    claims = packet.get("claims") or []
    if any(str(c.get("user_id", "")) == uid for c in claims):
        return jsonify({"status": "error", "message": "你已经抢过该红包了"}), 400
    if int(packet.get("remaining", 0) or 0) <= 0:
        return jsonify({"status": "error", "message": "红包已领完"}), 400
    resp, _ = _submit_action("redpacket_grab", {"uid": uid, "packet_id": packet_id})
    return resp


@app.route("/api/redpackets/history", methods=["GET"])
def api_redpackets_history():
    """红包历史：我发的/我抢的。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    rp = snap.get("redpackets") or {}
    packets = rp.get("packets") or []
    sent = []
    grabbed = []
    for p in packets:
        mine = str(p.get("sender_uid", "")) == uid
        if mine:
            sent.append(
                {
                    "id": p.get("id", ""),
                    "total": int(p.get("total", 0) or 0),
                    "count": int(p.get("count", 0) or 0),
                    "claims": p.get("claims") or [],
                    "created_at": p.get("created_at", 0),
                    "finished": bool(p.get("finished")),
                }
            )
        for c in p.get("claims") or []:
            if str(c.get("user_id", "")) == uid:
                grabbed.append(
                    {
                        "id": p.get("id", ""),
                        "amount": int(c.get("amount", 0)),
                        "created_at": c.get("t", 0),
                        "sender_name": p.get("sender_name", ""),
                    }
                )
    grabbed.sort(key=lambda x: x["created_at"], reverse=True)
    return jsonify(
        {"status": "ok", "data": {"sent": sent, "grabbed": grabbed}}
    )


# ---------- 竞拍 ----------


@app.route("/api/auction", methods=["GET"])
def api_auction():
    """竞拍列表（含我的出价状态）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    auction = snap.get("auction") or {}
    auctions = auction.get("auctions") or []
    items = []
    for a in auctions:
        bids = a.get("bids") or []
        my_top = next(
            (b for b in reversed(bids) if str(b.get("user_id", "")) == uid), None
        )
        items.append(
            {
                "id": a.get("id", ""),
                "creator_name": a.get("creator_name", ""),
                "name": a.get("name", ""),
                "desc": a.get("desc", ""),
                "start_price": int(a.get("start_price", 0) or 0),
                "increment": int(a.get("increment", 1) or 1),
                "current_bid": int(a.get("current_bid", 0) or 0),
                "current_bidder_name": a.get("current_bidder_name", ""),
                "current_bidder_uid": a.get("current_bidder_uid", ""),
                "is_top": bool(
                    a.get("current_bidder_uid") and str(a.get("current_bidder_uid")) == uid
                ),
                "my_bid": int(my_top.get("amount", 0)) if my_top else 0,
                "ends_at": a.get("ends_at", 0),
                "finished": bool(a.get("finished")),
                "created_at": a.get("created_at", 0),
            }
        )
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/auction/bid", methods=["POST"])
def api_auction_bid():
    """竞拍出价（冻结积分，被超价退回）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    auction_id = str(body.get("auction_id", "")).strip()
    try:
        amount = int(body.get("amount", 0))
    except (TypeError, ValueError):
        amount = 0
    if not auction_id:
        return jsonify({"status": "error", "message": "缺少竞拍ID"}), 400
    if amount < 1:
        return jsonify({"status": "error", "message": "出价需大于 0"}), 400
    snap = _load_snapshot()
    auction = snap.get("auction") or {}
    a = next(
        (x for x in auction.get("auctions") or [] if str(x.get("id", "")) == auction_id),
        None,
    )
    if a is None:
        return jsonify({"status": "error", "message": "竞拍不存在"}), 404
    if a.get("finished"):
        return jsonify({"status": "error", "message": "竞拍已结束"}), 400
    if str(a.get("current_bidder_uid", "")) == uid:
        return jsonify({"status": "error", "message": "您已是当前最高出价者"}), 400
    min_next = int(a.get("current_bid", 0) or 0) + int(a.get("increment", 1) or 1)
    if amount < min_next:
        return jsonify({"status": "error", "message": f"出价需不低于 {min_next} 积分"}), 400
    resp, _ = _submit_action(
        "auction_bid", {"uid": uid, "auction_id": auction_id, "amount": amount}
    )
    return resp


@app.route("/api/admin/auction/create", methods=["POST"])
def api_admin_auction_create():
    """管理员创建竞拍。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    name = str(body.get("name", "")).strip()[:100]
    desc = str(body.get("desc", "")).strip()[:300]
    try:
        start_price = int(body.get("start_price", 0))
    except (TypeError, ValueError):
        start_price = 0
    try:
        increment = int(body.get("increment", 1))
    except (TypeError, ValueError):
        increment = 1
    try:
        duration_hours = int(body.get("duration_hours", 24))
    except (TypeError, ValueError):
        duration_hours = 24
    if not name:
        return jsonify({"status": "error", "message": "请填写商品名称"}), 400
    if start_price < 0:
        start_price = 0
    if increment < 1:
        increment = 1
    if duration_hours < 1:
        duration_hours = 24
    payload = {
        "username": session.get("username"),
        "name": name,
        "desc": desc,
        "start_price": start_price,
        "increment": increment,
        "duration_hours": duration_hours,
    }
    resp, _ = _submit_action("auction_create", payload)
    return resp


# ---------- 站内邮箱（QQ号@qq.com，可附积分） ----------


def _email_of(uid: str) -> str:
    """按 QQ号 生成站内邮箱地址。"""
    uid = str(uid or "").strip()
    if uid.isdigit():
        return f"{uid}@qq.com"
    return f"{uid}@qq.com"


def _mail_view(row, my_uid: str) -> dict:
    return {
        "id": row["id"],
        "from_uid": row["from_uid"],
        "from_name": row["from_name"],
        "from_email": _email_of(row["from_uid"]),
        "to_uid": row["to_uid"],
        "to_name": row["to_name"],
        "to_email": _email_of(row["to_uid"]),
        "subject": row["subject"],
        "content": row["content"],
        "points": int(row["points"] or 0),
        "claimed": bool(row["claimed"]),
        "read": bool(row["read"]),
        "mine": str(row["from_uid"]) == str(my_uid),
        "created_at": row["created_at"],
    }


@app.route("/api/mail/inbox", methods=["GET"])
def api_mail_inbox():
    """站内邮箱：收件箱 + 发件箱 + 未读数（含全服广播）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM mail_messages WHERE from_uid=? OR to_uid=? OR to_uid='*ALL*' "
            "ORDER BY created_at DESC LIMIT 200",
            (uid, uid),
        ).fetchall()
        unread = conn.execute(
            "SELECT COUNT(*) AS c FROM mail_messages WHERE (to_uid=? OR to_uid='*ALL*') AND read=0",
            (uid,),
        ).fetchone()["c"]
    items = [_mail_view(r, uid) for r in rows]
    return jsonify({"status": "ok", "data": {"items": items, "unread": unread}})


@app.route("/api/mail/send", methods=["POST"])
def api_mail_send():
    """发送站内信。目标用 QQ号 或 邮箱地址，可附带积分（走插件扣款）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    to_raw = str(body.get("to", "")).strip()
    subject = str(body.get("subject", "")).strip()[:100]
    content = str(body.get("content", "")).strip()[:2000]
    try:
        points = int(body.get("points", 0))
    except (TypeError, ValueError):
        points = 0
    if not to_raw:
        return jsonify({"status": "error", "message": "请填写收件人"}), 400
    if not content:
        return jsonify({"status": "error", "message": "内容不能为空"}), 400
    if points < 0:
        points = 0
    if points > 1_000_000:
        return jsonify({"status": "error", "message": "附积分过大"}), 400
    # 解析目标 QQ号：去掉 @qq.com 后缀，保留纯数字部分
    to_uid = to_raw.split("@")[0].strip()
    if not to_uid.isdigit():
        # 支持按用户名查询
        acc = _get_account(to_raw)
        if acc is None:
            return jsonify({"status": "error", "message": "收件人不存在"}), 404
        to_uid = acc["uid"]
    if to_uid == uid:
        return jsonify({"status": "error", "message": "不能给自己发信"}), 400
    to_name = to_uid
    with _db() as conn:
        snap = _load_snapshot()
        for u in snap["users"]:
            if str(u.get("user_id", "")) == to_uid:
                to_name = u.get("user_name") or to_uid
                break
        mail_id = uuid.uuid4().hex[:16]
        from_name = session.get("username") or uid
        conn.execute(
            "INSERT INTO mail_messages (id, from_uid, from_name, to_uid, to_name, "
            "subject, content, points, claimed, read, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
            (mail_id, uid, from_name, to_uid, to_name, subject, content, points, time.time()),
        )
    if points > 0:
        resp, _ = _submit_action(
            "mail_send", {"uid": uid, "to_uid": to_uid, "points": points}
        )
        return resp
    return jsonify({"status": "ok", "message": "站内信已发送"})


@app.route("/api/mail/claim", methods=["POST"])
def api_mail_claim():
    """领取站内信附带的积分。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    mail_id = str(body.get("mail_id", "")).strip()
    if not mail_id:
        return jsonify({"status": "error", "message": "缺少邮件ID"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM mail_messages WHERE id=?", (mail_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "邮件不存在"}), 404
        if str(row["to_uid"]) != str(uid):
            return jsonify({"status": "error", "message": "这封邮件不是发给您的"}), 403
        if not row["points"] or row["claimed"]:
            return jsonify({"status": "error", "message": "该邮件没有可领取的积分"}), 400
        conn.execute(
            "UPDATE mail_messages SET claimed=1 WHERE id=?", (mail_id,)
        )
    resp, _ = _submit_action(
        "mail_claim", {"uid": uid, "points": int(row["points"]), "mail_id": mail_id}
    )
    return resp


@app.route("/api/mail/read", methods=["POST"])
def api_mail_read():
    """标记邮件已读。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    mail_id = str(body.get("mail_id", "")).strip()
    if not mail_id:
        return jsonify({"status": "error", "message": "缺少邮件ID"}), 400
    with _db() as conn:
        conn.execute(
            "UPDATE mail_messages SET read=1 WHERE id=? AND to_uid=?",
            (mail_id, uid),
        )
    return jsonify({"status": "ok", "message": "已读"})


@app.route("/api/admin/mail", methods=["POST"])
def api_admin_mail():
    """管理员在用户管理里快捷发信。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    to_uid = str(body.get("to_uid", "")).strip()
    subject = str(body.get("subject", "")).strip()[:100]
    content = str(body.get("content", "")).strip()[:2000]
    if not to_uid:
        return jsonify({"status": "error", "message": "缺少目标用户ID"}), 400
    if not content:
        return jsonify({"status": "error", "message": "内容不能为空"}), 400
    to_name = to_uid
    snap = _load_snapshot()
    for u in snap["users"]:
        if str(u.get("user_id", "")) == to_uid:
            to_name = u.get("user_name") or to_uid
            break
    admin_uid = _current_uid()
    admin_name = session.get("username") or admin_uid
    with _db() as conn:
        mail_id = uuid.uuid4().hex[:16]
        conn.execute(
            "INSERT INTO mail_messages (id, from_uid, from_name, to_uid, to_name, "
            "subject, content, points, claimed, read, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)",
            (mail_id, admin_uid, admin_name, to_uid, to_name, subject, content, time.time()),
        )
    return jsonify({"status": "ok", "message": "已发送站内信"})


@app.route("/api/admin/mail/broadcast", methods=["POST"])
def api_admin_mail_broadcast():
    """管理员给全服所有用户发站内信（广播）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    subject = str(body.get("subject", "")).strip()[:100]
    content = str(body.get("content", "")).strip()[:2000]
    if not content:
        return jsonify({"status": "error", "message": "内容不能为空"}), 400
    admin_uid = _current_uid()
    admin_name = session.get("username") or admin_uid
    with _db() as conn:
        mail_id = uuid.uuid4().hex[:16]
        conn.execute(
            "INSERT INTO mail_messages (id, from_uid, from_name, to_uid, to_name, "
            "subject, content, points, claimed, read, created_at) "
            "VALUES (?, ?, ?, '*ALL*', '全服用户', ?, ?, 0, 0, 0, ?)",
            (mail_id, admin_uid, admin_name, subject, content, time.time()),
        )
    return jsonify({"status": "ok", "message": "全服邮件已发送"})


# ---------- 用户反馈 ----------


@app.route("/api/feedback", methods=["POST"])
def api_feedback():
    """用户提交反馈。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    content = str(body.get("content", "")).strip()[:1000]
    if not content:
        return jsonify({"status": "error", "message": "反馈内容不能为空"}), 400
    username = session.get("username") or uid
    with _db() as conn:
        feedback_id = uuid.uuid4().hex[:16]
        conn.execute(
            "INSERT INTO feedback (id, uid, username, content, status, reply, created_at) "
            "VALUES (?, ?, ?, ?, 0, '', ?)",
            (feedback_id, uid, username, content, time.time()),
        )
    return jsonify({"status": "ok", "message": "反馈已提交，感谢您的建议"})


@app.route("/api/feedback/mine", methods=["GET"])
def api_feedback_mine():
    """查看我提交的反馈及处理状态。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM feedback WHERE uid=? ORDER BY created_at DESC LIMIT 50",
            (uid,),
        ).fetchall()
    items = [
        {
            "id": r["id"],
            "content": r["content"],
            "status": int(r["status"] or 0),
            "reply": r["reply"] or "",
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/admin/feedback", methods=["GET"])
def api_admin_feedback():
    """管理员查看全部反馈。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM feedback ORDER BY created_at DESC LIMIT 300"
        ).fetchall()
    items = [
        {
            "id": r["id"],
            "uid": r["uid"],
            "username": r["username"],
            "content": r["content"],
            "status": int(r["status"] or 0),
            "reply": r["reply"] or "",
            "created_at": r["created_at"],
        }
        for r in rows
    ]
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/admin/feedback/reply", methods=["POST"])
def api_admin_feedback_reply():
    """管理员回复反馈（标记已处理）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    feedback_id = str(body.get("id", "")).strip()
    reply = str(body.get("reply", "")).strip()[:1000]
    if not feedback_id:
        return jsonify({"status": "error", "message": "缺少反馈ID"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT 1 FROM feedback WHERE id=?", (feedback_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "反馈不存在"}), 404
        conn.execute(
            "UPDATE feedback SET status=1, reply=? WHERE id=?",
            (reply, feedback_id),
        )
    return jsonify({"status": "ok", "message": "已回复"})


# ---------- 积分使用记录（全服 / 单用户） ----------


@app.route("/api/admin/ledger", methods=["GET"])
def api_admin_ledger():
    """管理员查看全部积分使用记录（全服流水，支持按用户筛选）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    snap = _load_snapshot()
    filter_uid = str(request.args.get("uid", "")).strip()
    try:
        limit = int(request.args.get("limit", 500))
    except (TypeError, ValueError):
        limit = 500
    limit = max(1, min(limit, 2000))
    entries = []
    for u in snap["users"]:
        if filter_uid and str(u.get("user_id", "")) != filter_uid:
            continue
        name = _display_name(u)
        for e in u.get("ledger") or []:
            entries.append(
                {
                    "uid": str(u.get("user_id", "")),
                    "name": name,
                    "t": float(e.get("t", 0) or 0),
                    "delta": int(e.get("delta", 0) or 0),
                    "reason": e.get("reason", ""),
                    "note": e.get("note", ""),
                    "balance": int(e.get("balance", 0) or 0),
                }
            )
    entries.sort(key=lambda x: x["t"], reverse=True)
    entries = entries[:limit]
    return jsonify({"status": "ok", "data": {"items": entries}})


@app.route("/api/me/ledger/all", methods=["GET"])
def api_me_ledger_all():
    """当前用户查看自己的全部积分使用记录（含在快照内的所有流水）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    user = next((u for u in snap["users"] if str(u.get("user_id", "")) == uid), None)
    if not user:
        return jsonify({"status": "ok", "data": {"items": []}})
    entries = []
    for e in user.get("ledger") or []:
        entries.append(
            {
                "t": float(e.get("t", 0) or 0),
                "delta": int(e.get("delta", 0) or 0),
                "reason": e.get("reason", ""),
                "note": e.get("note", ""),
                "balance": int(e.get("balance", 0) or 0),
            }
        )
    entries.sort(key=lambda x: x["t"], reverse=True)
    return jsonify({"status": "ok", "data": {"items": entries}})


# ---------- 每日任务 ----------


def _today_str() -> str:
    return time.strftime("%Y-%m-%d")


def _task_record(conn, uid: str) -> dict:
    date = _today_str()
    row = conn.execute(
        "SELECT * FROM daily_tasks WHERE uid=? AND date=?", (uid, date)
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO daily_tasks (uid, date) VALUES (?, ?)", (uid, date)
        )
        row = conn.execute(
            "SELECT * FROM daily_tasks WHERE uid=? AND date=?", (uid, date)
        ).fetchone()
    return dict(row)


@app.route("/api/tasks", methods=["GET"])
def api_tasks():
    """每日任务：完成状态 + 可领取的奖励。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    user = next((u for u in snap["users"] if str(u.get("user_id", "")) == uid), None)
    signed_today = bool(user and user.get("last_sign_in") == _today_str())
    with _db() as conn:
        rec = _task_record(conn, uid)
        # 签到完成 = 今天已签到
        if signed_today and not rec["sign_done"]:
            conn.execute(
                "UPDATE daily_tasks SET sign_done=1 WHERE id=?", (rec["id"],)
            )
            rec["sign_done"] = 1
        chat_cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM chat_messages WHERE uid=? AND strftime('%Y-%m-%d', created_at, 'unixepoch', 'localtime')=?",
            (uid, _today_str()),
        ).fetchone()["c"]
        like_cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM board_replies WHERE author_uid=?", (uid,)
        ).fetchone()["c"]
        # 点赞任务：以 board 留言点赞为准（简化：当天有留言点赞则完成）
        today_like = 0
        for m in conn.execute("SELECT * FROM board_messages").fetchall():
            try:
                likes = json.loads(m["likes"] or "[]")
            except (json.JSONDecodeError, TypeError):
                likes = []
            if str(uid) in [str(x) for x in likes]:
                today_like = 1
                break
        if chat_cnt > 0 and not rec["chat_done"]:
            conn.execute("UPDATE daily_tasks SET chat_done=1 WHERE id=?", (rec["id"],))
            rec["chat_done"] = 1
        if today_like and not rec["like_done"]:
            conn.execute("UPDATE daily_tasks SET like_done=1 WHERE id=?", (rec["id"],))
            rec["like_done"] = 1
        # 兑换码任务：今天有兑换记录
        redeem_rows = conn.execute(
            "SELECT * FROM pending_actions WHERE type='redeem' ORDER BY created_at DESC LIMIT 10"
        ).fetchall()
        redeem_done = 0
        for r in redeem_rows:
            payload = json.loads(r["payload"] or "{}")
            if str(payload.get("uid", "")) == uid and r["status"] == "done":
                redeem_done = 1
                break
        if redeem_done and not rec["redeem_done"]:
            conn.execute("UPDATE daily_tasks SET redeem_done=1 WHERE id=?", (rec["id"],))
            rec["redeem_done"] = 1
    # 从插件推送的配置读取奖励（插件页面可配置）
    wc = snap.get("web_config") or {}
    conf = {
        "sign_in": int(wc.get("task_sign_in_reward", 5) or 5),
        "chat": int(wc.get("task_chat_reward", 5) or 5),
        "like": int(wc.get("task_like_reward", 3) or 3),
        "redeem": int(wc.get("task_redeem_reward", 5) or 5),
    }
    tasks = []
    for key, done_col, claim_col, label in (
        ("sign_in", "sign_done", "claimed_sign", "每日签到"),
        ("chat", "chat_done", "claimed_chat", "在聊天室发一条消息"),
        ("like", "like_done", "claimed_like", "在留言板点一个赞"),
        ("redeem", "redeem_done", "claimed_redeem", "使用一个兑换码"),
    ):
        done = bool(rec.get(done_col))
        claimed = bool(rec.get(claim_col))
        tasks.append(
            {
                "key": key,
                "label": label,
                "done": done,
                "claimed": claimed,
                "reward": conf.get(key, 0),
            }
        )
    return jsonify({"status": "ok", "data": {"tasks": tasks}})


@app.route("/api/tasks/claim", methods=["POST"])
def api_tasks_claim():
    """领取每日任务奖励积分。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    task = str(body.get("task", "")).strip()
    if task not in ("sign_in", "chat", "like", "redeem"):
        return jsonify({"status": "error", "message": "无效任务"}), 400
    with _db() as conn:
        rec = _task_record(conn, uid)
        done_col = "sign_done" if task == "sign_in" else f"{task}_done"
        claim_col = "claimed_sign" if task == "sign_in" else f"claimed_{task}"
        done = bool(rec.get(done_col))
        claimed = bool(rec.get(claim_col))
        if not done:
            return jsonify({"status": "error", "message": "任务尚未完成"}), 400
        if claimed:
            return jsonify({"status": "error", "message": "该任务今天已领取"}), 400
        conn.execute(
            f"UPDATE daily_tasks SET {claim_col}=1 WHERE id=?", (rec["id"],)
        )
    wc = (_load_snapshot().get("web_config") or {})
    conf = {
        "sign_in": int(wc.get("task_sign_in_reward", 5) or 5),
        "chat": int(wc.get("task_chat_reward", 5) or 5),
        "like": int(wc.get("task_like_reward", 3) or 3),
        "redeem": int(wc.get("task_redeem_reward", 5) or 5),
    }
    resp, _ = _submit_action(
        "task_claim",
        {"uid": uid, "task": task, "reward": conf.get(task, 0)},
    )
    return resp


# ---------- 兑换码批量生成（管理员） ----------


@app.route("/api/admin/redeem/generate", methods=["POST"])
def api_admin_redeem_generate():
    """管理员批量生成兑换码。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    try:
        points = int(body.get("points", 10))
    except (TypeError, ValueError):
        points = 10
    try:
        count = int(body.get("count", 1))
    except (TypeError, ValueError):
        count = 1
    if points < 1:
        points = 1
    count = max(1, min(count, 200))
    payload = {"username": session.get("username"), "points": points, "count": count}
    resp, _ = _submit_action("redeem_batch", payload)
    return resp


# ---------- 管理员导出 CSV ----------


@app.route("/api/admin/export/csv", methods=["GET"])
def api_admin_export_csv():
    """导出用户/积分 CSV（管理员）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    import csv
    import io

    snap = _load_snapshot()
    users = sorted(
        snap["users"], key=lambda u: int(u.get("points", 0) or 0), reverse=True
    )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["用户ID", "昵称", "积分", "签到天数", "连续签到", "会员等级", "被拉黑"])
    for u in users:
        writer.writerow(
            [
                u.get("user_id", ""),
                u.get("user_name", ""),
                int(u.get("points", 0) or 0),
                int(u.get("total_sign_in_days", 0) or 0),
                int(u.get("sign_in_streak", 0) or 0),
                int(u.get("vip_level", 0) or 0),
                "是" if u.get("blacklisted") else "否",
            ]
        )
    csv_data = buf.getvalue()
    from flask import Response

    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=points_export.csv"},
    )


# ---------- 留言板（数据仅存本站服务器） ----------


def _qq_avatar_url(uid: str) -> str:
    """根据 uid 生成 QQ 头像链接。

    uid 可能是「永久UID」（新数据）或「QQ号」（老数据）：
      1) 优先用 UID 反查网站账号 → 拿到真实QQ；
      2) 查不到再按"像不像QQ号"判断（7位且以1开头视为UID，不用）。
    """
    code = str(uid or "").strip()
    if not code:
        return ""
    qq = ""
    try:
        acc = _get_account_by_uid_code(code)
        if acc:
            qq = str(acc.get("uid", "") or "")
    except Exception:
        qq = ""
    if not qq and code.isdigit() and 5 <= len(code) <= 11:
        if not (len(code) == 7 and code.startswith("1")):
            qq = code
    if not qq:
        return ""
    return f"https://q1.qlogo.cn/g?b=qq&nk={qq}&s=100"


def _board_message_view(row, replies: list, uid: str) -> dict:
    try:
        likes = json.loads(row["likes"] or "[]")
    except (json.JSONDecodeError, TypeError):
        likes = []
    return {
        "id": row["id"],
        "author_uid": row["author_uid"],
        "author_name": row["author_name"],
        "avatar": _qq_avatar_url(row["author_uid"]),
        "content": row["content"],
        "pinned": bool(row["pinned"]),
        "likes": likes,
        "like_count": len(likes),
        "liked_by_me": str(uid) in [str(x) for x in likes],
        "mine": str(row["author_uid"]) == str(uid),
        "created_at": row["created_at"],
        "replies": replies,
    }


def _board_reply_view(row, uid: str) -> dict:
    return {
        "id": row["id"],
        "author_uid": row["author_uid"],
        "author_name": row["author_name"],
        "avatar": _qq_avatar_url(row["author_uid"]),
        "content": row["content"],
        "mine": str(row["author_uid"]) == str(uid),
        "created_at": row["created_at"],
    }


@app.route("/api/board", methods=["GET"])
def api_board():
    """留言板：列表（置顶优先，其次按时间倒序）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    with _db() as conn:
        msgs = conn.execute(
            "SELECT * FROM board_messages ORDER BY pinned DESC, created_at DESC"
        ).fetchall()
        reply_rows = conn.execute(
            "SELECT * FROM board_replies ORDER BY created_at ASC"
        ).fetchall()
    replies_by_msg: dict[str, list] = {}
    for r in reply_rows:
        replies_by_msg.setdefault(r["message_id"], []).append(
            _board_reply_view(r, uid)
        )
    # 每个用户最多一条留言
    active_ids = set()
    items = []
    for m in msgs:
        if str(m["author_uid"]) in active_ids:
            continue
        active_ids.add(str(m["author_uid"]))
        items.append(_board_message_view(m, replies_by_msg.get(m["id"], []), uid))
    return jsonify({"status": "ok", "data": {"items": items}})


@app.route("/api/board/post", methods=["POST"])
def api_board_post():
    """发布留言：每个用户始终只能有一条留言（删除后可重新发布）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    content = str(body.get("content", "")).strip()[:500]
    if not content:
        return jsonify({"status": "error", "message": "留言内容不能为空"}), 400
    username = session.get("username") or ""
    with _db() as conn:
        exists = conn.execute(
            "SELECT 1 FROM board_messages WHERE author_uid=? LIMIT 1", (uid,)
        ).fetchone()
        if exists:
            return jsonify(
                {"status": "error", "message": "您已经有一条留言了，请先删除原留言再发布"}
            ), 400
        msg_id = uuid.uuid4().hex[:16]
        conn.execute(
            "INSERT INTO board_messages (id, author_uid, author_name, content, pinned, likes, created_at) "
            "VALUES (?, ?, ?, ?, 0, '[]', ?)",
            (msg_id, uid, username, content, time.time()),
        )
    return jsonify({"status": "ok", "message": "留言发布成功"})


@app.route("/api/board/like", methods=["POST"])
def api_board_like():
    """点赞 / 取消点赞留言。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    msg_id = str(body.get("message_id", "")).strip()
    if not msg_id:
        return jsonify({"status": "error", "message": "缺少留言ID"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT likes FROM board_messages WHERE id=?", (msg_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "留言不存在"}), 404
        try:
            likes = json.loads(row["likes"] or "[]")
        except (json.JSONDecodeError, TypeError):
            likes = []
        uid_s = str(uid)
        liked = uid_s in [str(x) for x in likes]
        if liked:
            likes = [x for x in likes if str(x) != uid_s]
        else:
            likes.append(uid)
        conn.execute(
            "UPDATE board_messages SET likes=? WHERE id=?",
            (json.dumps(likes, ensure_ascii=False), msg_id),
        )
    return jsonify(
        {"status": "ok", "message": "已点赞" if not liked else "已取消点赞", "liked": not liked, "like_count": len(likes)}
    )


@app.route("/api/board/reply", methods=["POST"])
def api_board_reply():
    """回复留言。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    msg_id = str(body.get("message_id", "")).strip()
    content = str(body.get("content", "")).strip()[:200]
    if not msg_id:
        return jsonify({"status": "error", "message": "缺少留言ID"}), 400
    if not content:
        return jsonify({"status": "error", "message": "回复内容不能为空"}), 400
    username = session.get("username") or ""
    with _db() as conn:
        exists = conn.execute(
            "SELECT 1 FROM board_messages WHERE id=?", (msg_id,)
        ).fetchone()
        if exists is None:
            return jsonify({"status": "error", "message": "留言不存在"}), 404
        reply_id = uuid.uuid4().hex[:16]
        conn.execute(
            "INSERT INTO board_replies (id, message_id, author_uid, author_name, content, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (reply_id, msg_id, uid, username, content, time.time()),
        )
    return jsonify({"status": "ok", "message": "回复成功"})


@app.route("/api/board/delete", methods=["POST"])
def api_board_delete():
    """删除留言：作者本人或管理员。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    msg_id = str(body.get("message_id", "")).strip()
    if not msg_id:
        return jsonify({"status": "error", "message": "缺少留言ID"}), 400
    is_admin = _current_is_admin()
    with _db() as conn:
        row = conn.execute(
            "SELECT author_uid FROM board_messages WHERE id=?", (msg_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "留言不存在"}), 404
        if str(row["author_uid"]) != str(uid) and not is_admin:
            return jsonify({"status": "error", "message": "只能删除自己的留言"}), 403
        conn.execute("DELETE FROM board_messages WHERE id=?", (msg_id,))
        conn.execute("DELETE FROM board_replies WHERE message_id=?", (msg_id,))
    return jsonify({"status": "ok", "message": "留言已删除"})


@app.route("/api/board/delete_reply", methods=["POST"])
def api_board_delete_reply():
    """删除回复：回复作者本人或管理员。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    msg_id = str(body.get("message_id", "")).strip()
    reply_id = str(body.get("reply_id", "")).strip()
    if not msg_id or not reply_id:
        return jsonify({"status": "error", "message": "缺少参数"}), 400
    is_admin = _current_is_admin()
    with _db() as conn:
        row = conn.execute(
            "SELECT author_uid FROM board_replies WHERE id=?", (reply_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "回复不存在"}), 404
        if str(row["author_uid"]) != str(uid) and not is_admin:
            return jsonify({"status": "error", "message": "只能删除自己的回复"}), 403
        conn.execute("DELETE FROM board_replies WHERE id=? AND message_id=?", (reply_id, msg_id))
    return jsonify({"status": "ok", "message": "回复已删除"})


@app.route("/api/board/pin", methods=["POST"])
def api_board_pin():
    """置顶 / 取消置顶留言（仅管理员）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    if not _current_is_admin():
        return jsonify({"status": "error", "message": "无管理员权限"}), 403
    body = request.get_json(force=True, silent=True) or {}
    msg_id = str(body.get("message_id", "")).strip()
    pinned = bool(body.get("pinned", True))
    if not msg_id:
        return jsonify({"status": "error", "message": "缺少留言ID"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT 1 FROM board_messages WHERE id=?", (msg_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "留言不存在"}), 404
        conn.execute(
            "UPDATE board_messages SET pinned=? WHERE id=?", (1 if pinned else 0, msg_id)
        )
    return jsonify(
        {"status": "ok", "message": "已置顶" if pinned else "已取消置顶", "pinned": pinned}
    )


# ---------- 五子棋（联机房间，1v1，5秒轮询） ----------

GOMOKU_SIZE = 15


def _gomoku_new_board() -> list:
    return [[0] * GOMOKU_SIZE for _ in range(GOMOKU_SIZE)]


def _gomoku_check_win(board: list, r: int, c: int, player: int) -> bool:
    """判断 (r,c) 落子后是否五连。"""
    for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
        count = 1
        for sign in (1, -1):
            nr, nc = r + dr * sign, c + dc * sign
            while (
                0 <= nr < GOMOKU_SIZE
                and 0 <= nc < GOMOKU_SIZE
                and board[nr][nc] == player
            ):
                count += 1
                nr += dr * sign
                nc += dc * sign
        if count >= 5:
            return True
    return False


def _qq_of_uid(uid: str) -> str:
    """uid(永久UID 或 旧QQ号) → 真实QQ号；解析不到返回空串。"""
    code = str(uid or "").strip()
    if not code:
        return ""
    try:
        acc = _get_account_by_uid_code(code)
        if acc:
            return str(acc.get("uid", "") or "")
    except Exception:
        pass
    if code.isdigit() and 5 <= len(code) <= 11:
        if not (len(code) == 7 and code.startswith("1")):
            return code
    return ""


def _decorate_chat(messages: list) -> list:
    """给棋局聊天消息补上 qq（用于头像）。"""
    out = []
    for m in messages or []:
        if isinstance(m, dict):
            m = dict(m)
            m.setdefault("qq", _qq_of_uid(m.get("uid", "")))
        out.append(m)
    return out


def _gomoku_player_name(uid: str) -> str:
    snap = _load_snapshot()
    for u in snap["users"]:
        if str(u.get("user_id", "")) == uid:
            name = str(u.get("user_name") or "").strip()
            if name:
                return name
    acc = _get_account_by_uid(uid)
    if acc and acc.get("username"):
        return acc["username"]
    return uid


def _gomoku_game_dict(row) -> dict:
    return {
        "game_id": row["game_id"],
        "board": json.loads(row["board"] or "[]"),
        "player_black_uid": row["player_black_uid"],
        "player_black_name": row["player_black_name"],
        "player_black_qq": _qq_of_uid(row["player_black_uid"]),
        "player_white_uid": row["player_white_uid"],
        "player_white_name": row["player_white_name"],
        "player_white_qq": _qq_of_uid(row["player_white_uid"]),
        "current_turn": int(row["current_turn"] or 1),
        "status": row["status"],
        "winner": int(row["winner"] or 0),
        "resign_by": row["resign_by"] or "",
        "chat": _decorate_chat(json.loads(row["chat"] or "[]")),
        "last_move": json.loads(row["last_move"] or "null"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _gomoku_cleanup() -> None:
    with _db() as conn:
        conn.execute(
            "DELETE FROM gomoku_games WHERE status='finished' AND updated_at < ?",
            (time.time() - 3600,),
        )


@app.route("/api/gomoku/me", methods=["GET"])
def api_gomoku_me():
    """我的当前对局 + 大厅中等待加入的房间列表。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    _gomoku_cleanup()
    active = None
    waiting = []
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM gomoku_games WHERE status IN ('waiting','playing') "
            "AND (player_black_uid=? OR player_white_uid=?) ORDER BY updated_at DESC LIMIT 1",
            (uid, uid),
        ).fetchone()
        if row:
            active = _gomoku_game_dict(row)
        rows = conn.execute(
            "SELECT * FROM gomoku_games WHERE status='waiting' AND player_black_uid<>? "
            "ORDER BY created_at ASC LIMIT 50",
            (uid,),
        ).fetchall()
        waiting = [_gomoku_game_dict(r) for r in rows]
    return jsonify({"status": "ok", "data": {"active": active, "waiting": waiting}})


@app.route("/api/gomoku/state", methods=["GET"])
def api_gomoku_state():
    """拉取指定房间的对局状态（轮询）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    game_id = str(request.args.get("game_id", "")).strip()
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM gomoku_games WHERE game_id=?", (game_id,)
        ).fetchone()
    if row is None:
        return jsonify({"status": "error", "message": "房间不存在或已结束"}), 404
    return jsonify({"status": "ok", "data": _gomoku_game_dict(row)})


@app.route("/api/gomoku/create", methods=["POST"])
def api_gomoku_create():
    """创建房间（我执黑先手），等待对手加入。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    with _db() as conn:
        row = conn.execute(
            "SELECT game_id FROM gomoku_games WHERE status IN ('waiting','playing') "
            "AND (player_black_uid=? OR player_white_uid=?)",
            (uid, uid),
        ).fetchone()
        if row:
            return jsonify({"status": "error", "message": "你已在对局中，请先结束当前对局"}), 400
        game_id = uuid.uuid4().hex[:8]
        name = _gomoku_player_name(uid)
        board = _gomoku_new_board()
        now = time.time()
        conn.execute(
            "INSERT INTO gomoku_games (game_id, board, player_black_uid, player_black_name, "
            "current_turn, status, chat, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, 1, 'waiting', '[]', ?, ?)",
            (game_id, json.dumps(board), uid, name, now, now),
        )
    return jsonify({"status": "ok", "message": "房间已创建", "data": {"game_id": game_id}})


@app.route("/api/gomoku/join", methods=["POST"])
def api_gomoku_join():
    """加入房间（我执白后手）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    game_id = str(body.get("game_id", "")).strip()
    if not game_id:
        return jsonify({"status": "error", "message": "请输入房间号"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM gomoku_games WHERE game_id=?", (game_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "房间不存在"}), 404
        if row["status"] != "waiting":
            return jsonify({"status": "error", "message": "房间已开始或已结束"}), 400
        if row["player_black_uid"] == uid:
            return jsonify({"status": "error", "message": "不能加入自己创建的房间"}), 400
        r2 = conn.execute(
            "SELECT game_id FROM gomoku_games WHERE status IN ('waiting','playing') "
            "AND (player_black_uid=? OR player_white_uid=?)",
            (uid, uid),
        ).fetchone()
        if r2:
            return jsonify({"status": "error", "message": "你已在对局中，请先结束当前对局"}), 400
        name = _gomoku_player_name(uid)
        now = time.time()
        conn.execute(
            "UPDATE gomoku_games SET player_white_uid=?, player_white_name=?, "
            "status='playing', updated_at=? WHERE game_id=?",
            (uid, name, now, game_id),
        )
    return jsonify({"status": "ok", "message": "已加入房间，对局开始"})


@app.route("/api/gomoku/move", methods=["POST"])
def api_gomoku_move():
    """落子。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    game_id = str(body.get("game_id", "")).strip()
    try:
        r = int(body.get("r", -1))
        c = int(body.get("c", -1))
    except (TypeError, ValueError):
        r, c = -1, -1
    if not (0 <= r < GOMOKU_SIZE and 0 <= c < GOMOKU_SIZE):
        return jsonify({"status": "error", "message": "落子位置无效"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM gomoku_games WHERE game_id=?", (game_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "房间不存在或已结束"}), 404
        if row["status"] != "playing":
            return jsonify({"status": "error", "message": "对局未开始或已结束"}), 400
        turn = int(row["current_turn"] or 1)
        if uid != (row["player_black_uid"] if turn == 1 else row["player_white_uid"]):
            return jsonify({"status": "error", "message": "还没轮到你落子"}), 400
        board = json.loads(row["board"] or "[]")
        if board[r][c] != 0:
            return jsonify({"status": "error", "message": "该位置已有棋子"}), 400
        board[r][c] = turn
        win = _gomoku_check_win(board, r, c, turn)
        status = "finished" if win else "playing"
        winner = turn if win else 0
        next_turn = 2 if turn == 1 else 1
        now = time.time()
        conn.execute(
            "UPDATE gomoku_games SET board=?, current_turn=?, status=?, winner=?, "
            "last_move=?, updated_at=? WHERE game_id=?",
            (
                json.dumps(board),
                next_turn,
                status,
                winner,
                json.dumps({"r": r, "c": c}),
                now,
                game_id,
            ),
        )
    msg = "你赢了！" if win else "落子成功"
    return jsonify({"status": "ok", "message": msg, "win": win})


@app.route("/api/gomoku/chat", methods=["POST"])
def api_gomoku_chat():
    """对局内聊天。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    game_id = str(body.get("game_id", "")).strip()
    content = str(body.get("content", "")).strip()[:200]
    if not content:
        return jsonify({"status": "error", "message": "消息内容不能为空"}), 400
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM gomoku_games WHERE game_id=?", (game_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "房间不存在"}), 404
        chat = json.loads(row["chat"] or "[]")
        chat.append(
            {
                "uid": uid,
                "name": _gomoku_player_name(uid),
                "content": content,
                "t": time.time(),
            }
        )
        chat = chat[-100:]
        conn.execute(
            "UPDATE gomoku_games SET chat=?, updated_at=? WHERE game_id=?",
            (json.dumps(chat, ensure_ascii=False), time.time(), game_id),
        )
    return jsonify({"status": "ok", "message": "已发送"})


@app.route("/api/gomoku/resign", methods=["POST"])
def api_gomoku_resign():
    """认输；房间未开时创建者调用即取消房间。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    game_id = str(body.get("game_id", "")).strip()
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM gomoku_games WHERE game_id=?", (game_id,)
        ).fetchone()
        if row is None:
            return jsonify({"status": "error", "message": "房间不存在或已结束"}), 404
        if uid not in (row["player_black_uid"], row["player_white_uid"]):
            return jsonify({"status": "error", "message": "你不是本对局玩家"}), 403
        if row["status"] == "waiting":
            conn.execute("DELETE FROM gomoku_games WHERE game_id=?", (game_id,))
            return jsonify({"status": "ok", "message": "房间已取消"})
        if row["status"] != "playing":
            return jsonify({"status": "error", "message": "对局已结束"}), 400
        winner = 2 if uid == row["player_black_uid"] else 1
        conn.execute(
            "UPDATE gomoku_games SET status='finished', winner=?, resign_by=?, updated_at=? "
            "WHERE game_id=?",
            (winner, uid, time.time(), game_id),
        )
    return jsonify({"status": "ok", "message": "你已认输"})


@app.route("/api/me/ledger", methods=["GET"])
def api_me_ledger():
    """当前用户的积分流水明细。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    user = None
    for u in snap["users"]:
        if str(u.get("user_id", "")) == uid:
            user = u
            break
    if not user:
        return jsonify({"status": "ok", "data": {"items": [], "found": False}})
    return jsonify(
        {"status": "ok", "data": {"found": True, "items": user.get("ledger") or []}}
    )


@app.route("/api/me/bio", methods=["POST"])
def api_me_bio():
    """保存个人签名（本地插件写入账号记录，随同步回传）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    bio = str(body.get("bio", "")).strip()[:200]
    resp, _ = _submit_action("set_bio", {"username": session.get("username"), "bio": bio})
    return resp


@app.route("/api/recover", methods=["POST"])
def api_recover():
    """找回密码：用户名 + 校验ID + 新密码。"""
    body = request.get_json(force=True, silent=True) or {}
    username = str(body.get("username", "")).strip()
    verify_id = str(body.get("verify_id", "")).strip()
    new_password = str(body.get("new_password", "")).strip()
    if not username or not verify_id or not new_password:
        return jsonify({"status": "error", "message": "请填写完整信息"}), 400
    if len(new_password) < 6:
        return jsonify({"status": "error", "message": "新密码至少 6 位"}), 400
    if _get_account(username) is None:
        return jsonify({"status": "error", "message": "账号不存在"}), 400
    resp, _ = _submit_action(
        "recover",
        {"username": username, "verify_id": verify_id, "new_password": new_password},
    )
    return resp


@app.route("/api/announcements", methods=["GET"])
def api_announcements():
    """系统公告（公开只读）。"""
    with _db() as conn:
        row = conn.execute("SELECT * FROM announcements WHERE id=1").fetchone()
    if not row or not row["content"]:
        return jsonify({"status": "ok", "data": {"content": "", "updated_at": 0}})
    return jsonify(
        {
            "status": "ok",
            "data": {
                "content": row["content"],
                "author": row["author"],
                "updated_at": row["updated_at"],
            },
        }
    )


@app.route("/api/version", methods=["GET"])
def api_version():
    """版本与同步状态校验（公开）。

    满足以下条件网站才可用：
    1. 收到过插件同步数据（version 非空）；
    2. 插件版本与网站版本一致；
    3. 插件仍在持续同步（最近推送未超时，即插件未关闭同步/未离线）。
    任一不满足则网站黑屏不可用。
    """
    snap = _load_snapshot()
    plugin_version = snap.get("version") or ""
    updated_at = float(snap.get("updated_at") or 0)
    now = time.time()
    age = int(now - updated_at) if updated_at else -1
    stale = updated_at == 0 or age > STALE_TIMEOUT
    match = bool(plugin_version) and plugin_version == WEB_VERSION
    if stale:
        message = (
            "尚未收到插件同步数据，请确认本地插件已更新并启用「网站同步」"
            if updated_at == 0
            else f"本地插件同步已停止（{age} 秒前），请检查插件「网站同步」是否已启用或插件是否离线"
        )
    elif not match:
        message = f"版本不匹配：网站 {WEB_VERSION}，插件 {plugin_version}，请同步更新后重试"
    else:
        message = ""
    return jsonify(
        {
            "status": "ok",
            "data": {
                "web_version": WEB_VERSION,
                "plugin_version": plugin_version,
                "last_sync": int(updated_at),
                "sync_age": age,
                "stale": stale,
                "match": match,
                "ok": match and not stale,
                "message": message,
            },
        }
    )


# ---------- 网站设置 / 动漫背景 ----------

DEFAULT_BG_API = "https://pic.2333404.xyz/pic?img=ua"


def _site_bg_settings() -> dict:
    wc = _load_snapshot().get("web_config") or {}
    return {
        "enabled": bool(wc.get("site_background_enabled", True)),
        "api": str(wc.get("site_background_api") or DEFAULT_BG_API),
        "refresh": max(0, int(wc.get("site_background_refresh") or 10)),
    }


def _extract_bg_url(obj) -> str | None:
    """从外接API返回的JSON中尽量提取一张图片URL。"""
    if isinstance(obj, dict):
        for k in ("url", "imgurl", "image", "img", "pic", "src", "data"):
            v = obj.get(k)
            if isinstance(v, str) and v.startswith("http"):
                return v
            if isinstance(v, dict):
                u = _extract_bg_url(v)
                if u:
                    return u
            if isinstance(v, list) and v:
                u = _extract_bg_url(v[0])
                if u:
                    return u
        for v in obj.values():
            if (
                isinstance(v, str)
                and v.startswith("http")
                and any(x in v.lower() for x in (".jpg", ".jpeg", ".png", ".webp", ".gif"))
            ):
                return v
    elif isinstance(obj, list):
        for item in obj:
            u = _extract_bg_url(item)
            if u:
                return u
    return None


@app.route("/api/site-settings", methods=["GET"])
def api_site_settings():
    """网站设置 + 插件连接状态（离线也可用）。"""
    cfg = _site_bg_settings()
    snap = _load_snapshot()
    plugin_version = snap.get("version") or ""
    updated_at = float(snap.get("updated_at") or 0)
    age = int(time.time() - updated_at) if updated_at else -1
    stale = updated_at == 0 or age > STALE_TIMEOUT
    match = bool(plugin_version) and plugin_version == WEB_VERSION
    return jsonify(
        {
            "status": "ok",
            "data": {
                "bg_enabled": cfg["enabled"],
                "bg_refresh": cfg["refresh"],
                "bg_api": cfg["api"],
                "online": match and not stale,
                "match": match,
                "stale": stale,
                "plugin_version": plugin_version,
                "web_version": WEB_VERSION,
                "sync_age": age,
            },
        }
    )


# 背景兜底图源（顺序尝试；手机UA取竖屏）
BG_FALLBACK_SOURCES = [
    "https://pic.2333404.xyz/pic?img=ua",
    "https://www.dmoe.cc/random.php",
    "https://pic.sumi.us.ci/v",
]


@app.route("/api/bg", methods=["GET"])
def api_bg():
    """图片代理：服务端抓取一张随机动漫背景，直接以图片返回给前端。

    浏览器只连本站（PythonAnywhere），由服务器去访问外站，彻底避免用户网络
    访问不到图床 / 跨域 / 防盗链导致观赏模式黑屏。多来源逐个尝试。
    """
    import urllib.request

    cfg = _site_bg_settings()
    sources = []
    api_url = str(cfg.get("api") or "").strip()
    if api_url:
        sources.append(api_url)
    for u in BG_FALLBACK_SOURCES:
        if u not in sources:
            sources.append(u)

    mobile_ua = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    )

    def _fetch(url: str):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": mobile_ua,
                "Referer": "https://bot.2333404.xyz/",
            },
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            ctype = str(resp.headers.get("Content-Type", "")).lower()
            if "image" in ctype:
                data = resp.read(3 * 1024 * 1024)
                if not data:
                    raise ValueError("empty image")
                return data, ctype.split(";")[0].strip()
            data = resp.read(512 * 1024)
            try:
                obj = json.loads(data)
            except Exception:
                obj = None
            u = _extract_bg_url(obj)
            if not u:
                raise ValueError("no image url in json")
            return _fetch(u)

    for src in sources:
        try:
            data, ctype = _fetch(src)
            r = Response(data, mimetype=ctype)
            r.headers["Cache-Control"] = "no-store"
            return r
        except Exception as e:
            continue
    # 全失败兜底：返回本站本地生成的渐变图（保证永远有图，绝不黑屏/502）
    fallback_svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" '
        'viewBox="0 0 1080 1920">'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0%" stop-color="#2b1a4d"/>'
        '<stop offset="45%" stop-color="#6a2c70"/>'
        '<stop offset="75%" stop-color="#d76d77"/>'
        '<stop offset="100%" stop-color="#ffaf7b"/>'
        '</linearGradient></defs>'
        '<rect width="1080" height="1920" fill="url(#g)"/>'
        "</svg>"
    )
    r = Response(fallback_svg, mimetype="image/svg+xml")
    r.headers["Cache-Control"] = "no-store"
    return r


@app.route("/api/shop", methods=["GET"])
def api_shop():
    """商城商品列表（登录即可查看）。"""
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    snap = _load_snapshot()
    shop = snap.get("shop") or {}
    products = shop.get("products") or []
    return jsonify(
        {"status": "ok", "data": {"products": products, "total": len(products)}}
    )


@app.route("/api/shop/order", methods=["POST"])
def api_shop_order():
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    product_id = str(body.get("product_id", "")).strip()
    if not product_id:
        return jsonify({"status": "error", "message": "缺少商品ID"}), 400
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'shop_order', ?, 'pending', ?)",
            (
                action_id,
                json.dumps({"uid": uid, "product_id": product_id}, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {
            "status": "ok",
            "message": "兑换申请已提交，稍后生效",
            "data": {"id": action_id},
        }
    )


# ---------- 管理员接口 ----------


def _require_admin():
    uid = _require_login()
    if not uid:
        return "未登录"
    if not _current_is_admin():
        return "无管理员权限"
    return None


@app.route("/api/admin/users", methods=["GET"])
def api_admin_users():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    snap = _load_snapshot()
    users = sorted(
        snap["users"], key=lambda u: int(u.get("points", 0) or 0), reverse=True
    )
    items = [dict(u) for u in users]
    for u in items:
        u["display_name"] = _display_name(u)
    return jsonify({"status": "ok", "data": {"items": items, "total": len(items)}})


@app.route("/api/admin/accounts", methods=["GET"])
def api_admin_accounts():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM accounts ORDER BY username"
        ).fetchall()
    items = []
    for row in rows:
        items.append(
            {
                "username": row["username"],
                "uid": row["uid"],
                "password": row["password_plain"]
                if "password_plain" in row.keys()
                else "",
                "enabled": bool(row["enabled"]),
                "is_admin": bool(row["is_admin"]),
            }
        )
    return jsonify({"status": "ok", "data": {"items": items, "total": len(items)}})


@app.route("/api/admin/images", methods=["GET"])
def api_admin_images():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    snap = _load_snapshot()
    images = sorted(
        snap["images"], key=lambda i: i.get("created_at", 0) or 0, reverse=True
    )
    return jsonify({"status": "ok", "data": {"items": images, "total": len(images)}})


@app.route("/api/admin/redeem_codes", methods=["GET"])
def api_admin_redeem_codes():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    # 兑换码列表从本地插件同步（当前快照不含兑换码），此处返回占位说明
    return jsonify(
        {
            "status": "ok",
            "data": {"note": "兑换码请到机器人 Web 管理页管理", "items": []},
        }
    )


@app.route("/api/admin/shop", methods=["GET"])
def api_admin_shop():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    snap = _load_snapshot()
    shop = snap.get("shop") or {}
    return jsonify(
        {
            "status": "ok",
            "data": {
                "products": shop.get("products") or [],
                "orders": shop.get("orders") or [],
            },
        }
    )


@app.route("/api/admin/bottles", methods=["GET"])
def api_admin_bottles():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    snap = _load_snapshot()
    return jsonify(
        {"status": "ok", "data": {"items": snap.get("bottles") or [], "total": len(snap.get("bottles") or [])}}
    )


@app.route("/api/admin/op", methods=["POST"])
def api_admin_op():
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    payload = dict(body)
    payload["username"] = session.get("username")
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'admin_op', ?, 'pending', ?)",
            (
                action_id,
                json.dumps(payload, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {"status": "ok", "message": "操作已提交，稍后生效", "data": {"id": action_id}}
    )


@app.route("/api/admin/announcement", methods=["POST"])
def api_admin_announcement():
    """管理员发布/清空系统公告（保存在本站数据库）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    content = str(body.get("content", "")).strip()[:1000]
    username = session.get("username")
    with _db() as conn:
        conn.execute(
            "INSERT INTO announcements (id, content, author, updated_at) "
            "VALUES (1, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET content=excluded.content, "
            "author=excluded.author, updated_at=excluded.updated_at",
            (content, username, time.time()),
        )
    if content:
        return jsonify({"status": "ok", "message": "公告已发布"})
    return jsonify({"status": "ok", "message": "公告已清空"})


@app.route("/api/admin/lottery", methods=["GET"])
def api_admin_lottery():
    """管理员查看抽奖与瓜分池当前配置。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    snap = _load_snapshot()
    lottery = snap.get("lottery") or {}
    return jsonify(
        {
            "status": "ok",
            "data": {
                "cost": int(lottery.get("cost") or 10),
                "prizes": lottery.get("prizes") or [],
                "split": snap.get("split") or {},
            },
        }
    )


@app.route("/api/admin/lottery", methods=["POST"])
def api_admin_lottery_save():
    """管理员保存抽奖配置（调整爆率）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    try:
        cost = int(body.get("cost", 10))
    except (TypeError, ValueError):
        cost = 10
    if cost < 1:
        cost = 1
    prizes = body.get("prizes") or []
    normalized = []
    for p in prizes:
        if not isinstance(p, dict):
            continue
        name = str(p.get("name", "")).strip()
        if not name:
            continue
        try:
            points = int(p.get("points", 0))
        except (TypeError, ValueError):
            points = 0
        try:
            weight = int(p.get("weight", 1))
        except (TypeError, ValueError):
            weight = 1
        if weight < 0:
            weight = 0
        normalized.append({"name": name, "points": max(0, points), "weight": weight})
    if not normalized:
        return jsonify({"status": "error", "message": "奖品列表不能为空"}), 400
    payload = dict(body)
    payload["username"] = session.get("username")
    payload["cost"] = cost
    payload["prizes"] = normalized
    resp, _ = _submit_action("lottery_config", payload)
    return resp


@app.route("/api/admin/split", methods=["POST"])
def api_admin_split():
    """管理员设置瓜分池（余额 + 单次份额范围，开启新一轮）。"""
    err = _require_admin()
    if err:
        return jsonify({"status": "error", "message": err}), 403
    body = request.get_json(force=True, silent=True) or {}
    try:
        balance = int(body.get("balance", 0))
    except (TypeError, ValueError):
        balance = 0
    try:
        min_share = int(body.get("min_share", 1))
    except (TypeError, ValueError):
        min_share = 1
    try:
        max_share = int(body.get("max_share", 50))
    except (TypeError, ValueError):
        max_share = 50
    if balance < 0:
        balance = 0
    if min_share < 1:
        min_share = 1
    if max_share < min_share:
        max_share = min_share
    payload = {
        "username": session.get("username"),
        "balance": balance,
        "min_share": min_share,
        "max_share": max_share,
    }
    resp, _ = _submit_action("split_config", payload)
    return resp


@app.route("/api/redeem", methods=["POST"])
def api_redeem():
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    body = request.get_json(force=True, silent=True) or {}
    code = str(body.get("code", "")).strip()
    if not code:
        return jsonify({"status": "error", "message": "请填写兑换码"}), 400
    action_id = uuid.uuid4().hex[:16]
    with _db() as conn:
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'redeem', ?, 'pending', ?)",
            (
                action_id,
                json.dumps({"uid": uid, "code": code}, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {
            "status": "ok",
            "message": "兑换申请已提交，积分到账前请等待数秒后刷新查询",
            "data": {"id": action_id},
        }
    )


@app.route("/api/upload", methods=["POST"])
def api_upload():
    uid = _require_login()
    if not uid:
        return jsonify({"status": "error", "message": "未登录"}), 401
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"status": "error", "message": "请选择图片"}), 400
    ext = os.path.splitext(file.filename)[1].lower() or ".png"
    upload_id = uuid.uuid4().hex[:12]
    filename = f"{upload_id}{ext}"
    file.save(os.path.join(UPLOAD_DIR, filename))
    size = os.path.getsize(os.path.join(UPLOAD_DIR, filename))
    public_url = f"{request.url_root.rstrip('/')}/static/uploads/{filename}"
    with _db() as conn:
        conn.execute(
            "INSERT INTO uploads (id, owner_uid, filename, public_url, size, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (upload_id, uid, filename, public_url, size, time.time()),
        )
        action_id = uuid.uuid4().hex[:16]
        conn.execute(
            "INSERT INTO pending_actions (id, type, payload, status, created_at) "
            "VALUES (?, 'upload', ?, 'pending', ?)",
            (
                action_id,
                json.dumps({"upload_id": upload_id}, ensure_ascii=False),
                time.time(),
            ),
        )
    return jsonify(
        {
            "status": "ok",
            "message": "图片已上传，正在同步，请稍后查看",
            "data": {"id": upload_id, "url": public_url},
        }
    )


@app.route("/static/uploads/<path:filename>")
def serve_upload(filename: str):
    return send_from_directory(UPLOAD_DIR, filename)


# ---------- 页面 ----------


@app.route("/")
def index():
    return render_template("index.html")


_init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
