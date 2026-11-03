import copy
import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4


def timestamp():
    return datetime.now(UTC).isoformat()


def identity():
    return uuid4().hex


# Manual saves and pre-delete backups are never pruned; automatic backups keep the newest N per course.
PROTECTED_VERSION_REASONS = ("手动保存", "删除前完整备份（本地回收区）", "示例课程初始状态")
AUTOMATIC_VERSIONS_KEPT = 30


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / "learning.sqlite3"
        with self.connect() as connection:
            connection.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS courses
                  (id TEXT PRIMARY KEY, revision INTEGER, body TEXT, deleted INTEGER DEFAULT 0);
                CREATE TABLE IF NOT EXISTS versions
                  (id TEXT PRIMARY KEY, course_id TEXT, created_at TEXT, reason TEXT, body TEXT);
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT);
                CREATE TABLE IF NOT EXISTS confirmations
                  (token TEXT PRIMARY KEY, course_id TEXT, revision INTEGER, created_at TEXT,
                   action TEXT, body TEXT);
                CREATE TABLE IF NOT EXISTS ai_tasks
                  (id TEXT PRIMARY KEY, course_id TEXT, request_key TEXT, kind TEXT, target TEXT,
                   state TEXT, body TEXT, updated_at TEXT, UNIQUE(course_id,request_key));
                CREATE INDEX IF NOT EXISTS idx_ai_tasks_course_id ON ai_tasks(course_id);
                CREATE TABLE IF NOT EXISTS ai_task_events
                  (task_id TEXT, sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT);
                CREATE TABLE IF NOT EXISTS ai_conversations
                  (id TEXT PRIMARY KEY, course_id TEXT, logical_key TEXT, identity_json TEXT,
                   thread_id TEXT, owner_task TEXT, updated_at TEXT);
                CREATE INDEX IF NOT EXISTS idx_ai_conversations_logical ON ai_conversations(logical_key);
                CREATE TABLE IF NOT EXISTS codex_sidebar_evidence (course_id TEXT PRIMARY KEY, body TEXT);
                CREATE TABLE IF NOT EXISTS codex_native_groups (course_id TEXT PRIMARY KEY, section_id TEXT);
            """)

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def list_courses(self):
        with self.connect() as connection:
            return self.active_courses(connection)

    def course(self, course_id, connection=None):
        if connection is None:
            with self.connect() as opened:
                return self.course(course_id, opened)
        row = connection.execute("SELECT body FROM courses WHERE id=? AND deleted=0", (course_id,)).fetchone()
        if row is None:
            raise KeyError("课程不存在或已移入本地回收区")
        return json.loads(row["body"])

    def create(self, title):
        title = title.strip()
        if not title or len(title) > 160:
            raise ValueError("课程名称应为 1–160 个字符")
        course = dict(
            id=identity(),
            title=title,
            revision=0,
            created_at=timestamp(),
            materials=[],
            nodes=[],
            edges=[],
            ratings=[],
            suggestions=[],
            preferences={"pace": "按内容决定", "difficulty": "初始估计"},
        )
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if any(
                existing["title"].casefold() == title.casefold()
                for existing in self.active_courses(connection)
            ):
                raise ValueError("已有同名学科，请向现有课程添加材料")
            connection.execute(
                "INSERT INTO courses(id,revision,body) VALUES(?,?,?)",
                (course["id"], 0, json.dumps(course, ensure_ascii=False)),
            )
        (self.root / "courses" / course["id"]).mkdir(parents=True)
        return course

    @staticmethod
    def active_courses(connection):
        return [
            json.loads(row[0])
            for row in connection.execute("SELECT body FROM courses WHERE deleted=0 ORDER BY rowid")
        ]

    @contextmanager
    def edit(self, course_id, expected=None, *, task_id=None):
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            course = self.course(course_id, connection)
            original_course = copy.deepcopy(course) if task_id else None
            if expected is not None and course["revision"] != expected:
                raise Conflict("课程已在其他操作中改变，请刷新后重试；已有进度未覆盖")
            yield course, connection
            task = None
            task_body = None
            if task_id is not None:
                task = connection.execute("SELECT * FROM ai_tasks WHERE id=?", (task_id,)).fetchone()
                if task is None:
                    raise Conflict("AI 任务不存在，课程未应用")
                if task["course_id"] != course_id:
                    raise Conflict("AI 任务与课程不匹配，课程未应用")
                if task["state"] == "applied":
                    raise Conflict("AI 任务已应用，不能重复应用")
                if task["state"] not in {"received", "processing"}:
                    raise Conflict("AI 任务当前状态不能应用，课程未改变")
                task_body = json.loads(task["body"])
                from .conversation_sessions import require_current_conversation

                require_current_conversation(task_body | dict(kind=task["kind"], target=task["target"]), course)
                before = task_body["before"]
                if (before.get("ai_epoch") != course.get("ai_epoch")
                        or before["materials"] != course["materials"]
                        or before.get("review_scope") != course.get("review_scope")):
                    raise Conflict("AI 请求后课程材料、范围或恢复状态已改变，结果已保留但未应用")
            self.save_course(course, connection)
            if task is not None:
                from .ai_result_refs import result_record

                original_body = json.dumps(original_course, ensure_ascii=False)
                saved = connection.execute("SELECT 1 FROM versions WHERE course_id=? AND body=? LIMIT 1",
                                           (course_id, original_body)).fetchone()
                if not saved:
                    self.snapshot(original_course, "应用 AI 结果前自动备份", connection)
                task_body["applied_revision"] = course["revision"]
                if task_body.get("result_type") != "value":
                    task_body["result"] = {"course_id": course_id, "revision": course["revision"]}
                receipt = task_body | {"kind": task["kind"], "target": task["target"], "course_id": course_id}
                task_body.update(result_record(receipt, course))
                connection.execute(
                    "UPDATE ai_tasks SET state='applied',body=?,updated_at=? WHERE id=?",
                    (json.dumps(task_body, ensure_ascii=False), timestamp(), task_id),
                )

    @staticmethod
    def save_course(course, connection):
        course["revision"] += 1
        connection.execute(
            "UPDATE courses SET body=?,revision=? WHERE id=?",
            (json.dumps(course, ensure_ascii=False), course["revision"], course["id"]),
        )

    def snapshot(self, course, reason, connection):
        version_id = identity()
        connection.execute(
            "INSERT INTO versions VALUES(?,?,?,?,?)",
            (version_id, course["id"], timestamp(), reason, json.dumps(course, ensure_ascii=False)),
        )
        if reason not in PROTECTED_VERSION_REASONS:
            # Automatic backups contain the whole course (lesson HTML included); keep only the newest ones.
            connection.execute(
                f"""DELETE FROM versions WHERE course_id=? AND reason NOT IN ({",".join("?" * len(PROTECTED_VERSION_REASONS))})
                    AND id NOT IN (
                      SELECT id FROM versions WHERE course_id=?
                        AND reason NOT IN ({",".join("?" * len(PROTECTED_VERSION_REASONS))})
                      ORDER BY created_at DESC, rowid DESC LIMIT ?)""",
                (course["id"], *PROTECTED_VERSION_REASONS, course["id"], *PROTECTED_VERSION_REASONS,
                 AUTOMATIC_VERSIONS_KEPT),
            )
        return version_id

    def versions(self, course_id):
        self.course(course_id)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM versions WHERE course_id=? ORDER BY created_at DESC", (course_id,)
            )
            return [
                dict(
                    id=row["id"],
                    created_at=row["created_at"],
                    reason=row["reason"],
                    node_count=len(json.loads(row["body"])["nodes"]),
                    revision=json.loads(row["body"])["revision"],
                )
                for row in rows
            ]

    def version(self, course_id, version_id, connection):
        row = connection.execute(
            "SELECT body FROM versions WHERE id=? AND course_id=?", (version_id, course_id)
        ).fetchone()
        if row is None:
            raise KeyError("版本不存在")
        return json.loads(row[0])

    def preview(self, action, body, course=None, *, connection=None):
        if connection is None:
            with self.connect() as opened:
                opened.execute("BEGIN IMMEDIATE")
                return self.preview(action, body, course, connection=opened)
        token = identity()
        # Confirmations expire after 15 minutes; drop stale ones so the table does not grow forever.
        expired = (datetime.now(UTC) - timedelta(days=1)).isoformat()
        connection.execute("DELETE FROM confirmations WHERE created_at < ?", (expired,))
        connection.execute(
            "INSERT INTO confirmations VALUES(?,?,?,?,?,?)",
            (token, course["id"] if course else None, course["revision"] if course else None,
             timestamp(), action, json.dumps(body, ensure_ascii=False)),
        )
        return token

    def consume(self, token, action, connection, course=None):
        row = connection.execute("SELECT * FROM confirmations WHERE token=?", (token,)).fetchone()
        if row is None or row["action"] != action:
            raise ValueError("确认已失效，请重新预览")
        age = datetime.now(UTC) - datetime.fromisoformat(row["created_at"])
        if age.total_seconds() > 900:
            raise Conflict("预览超过 15 分钟，请重新检查内容")
        if course and (row["course_id"] != course["id"] or row["revision"] != course["revision"]):
            raise Conflict("预览后课程有变化，请重新预览")
        connection.execute("DELETE FROM confirmations WHERE token=?", (token,))
        return json.loads(row["body"])

    def settings(self, connection=None):
        if connection is None:
            with self.connect() as opened:
                return self.settings(opened)
        defaults = dict(
            ai_enabled=False, model="", note_review_model="gpt-6-luna", goal_model="", reasoning_effort="medium",
            obsidian_vault="", parser="basic"
        )
        row = connection.execute("SELECT body FROM settings WHERE key='main'").fetchone()
        return defaults | (json.loads(row[0]) if row else {})

    def save_settings(self, settings, connection=None):
        if connection is None:
            with self.connect() as opened:
                self.save_settings(settings, opened)
            return
        connection.execute(
            "INSERT OR REPLACE INTO settings VALUES('main',?)",
            (json.dumps(settings, ensure_ascii=False),),
        )

    def restore(self, course_id, token):
        from .conversation_send_gate import conversation_send_gate

        with conversation_send_gate(self), self.edit(course_id) as (course, connection):
            request = self.consume(token, "restore", connection, course)
            saved = self.version(course_id, request["version_id"], connection)
            self.snapshot(course, "恢复前自动备份", connection)
            revision = course["revision"]
            course.clear()
            course.update(copy.deepcopy(saved), revision=revision, ai_epoch=identity())
            rows = connection.execute(
                "SELECT id,body FROM ai_tasks WHERE course_id=? AND state!='applied'", (course_id,)
            ).fetchall()
            for row in rows:
                task_body = json.loads(row["body"])
                task_body["error"] = "课程已恢复，旧任务不会重新应用"
                connection.execute(
                    "UPDATE ai_tasks SET state='superseded',body=?,updated_at=? WHERE id=?",
                    (json.dumps(task_body, ensure_ascii=False), timestamp(), row["id"]),
                )
            for node in course["nodes"]:
                node["thread_id"] = None
                node["review_threads"] = {}
        return self.course(course_id)

    def archive(self, course_id, token):
        with self.edit(course_id) as (course, connection):
            self.consume(token, "delete", connection, course)
            self.snapshot(course, "删除前完整备份（本地回收区）", connection)
            connection.execute("UPDATE courses SET deleted=1 WHERE id=?", (course_id,))
