"""Stable conversation selection; SQLite claims prevent overlapping sends."""

import hashlib
import json

from .conversation_send_gate import conversation_send_gate
from .review_scope import scope_key, thread_for
from .store import Conflict, timestamp

NODE_CHANNELS = {"chat": "learning", "lesson": "learning", "question": "assessment",
                 "assessment": "assessment", "note_review": "note_review", "recall": "recall"}
COURSE_CHANNELS = {"bridge": "bridges", "bridge_history": "bridges", "links": "bridges",
                   "teaching_plan": "teaching_plans"}
# Only the tutor conversation relies on earlier turns; every other prompt carries its own context.
PERSISTENT_CHANNELS = {"learning"}


def _digest(identity):
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def conversation_scope(task):
    return scope_key(task["before"]) if task["kind"] in NODE_CHANNELS else "course"


def logical_identity(task):
    course = task["before"]
    node = next((node for node in course["nodes"] if node["id"] == task["target"]), {})
    channel = NODE_CHANNELS.get(task["kind"], COURSE_CHANNELS.get(task["kind"], task["kind"]))
    target = "course" if task["kind"] in {"map", "bridge", "bridge_history", "links", "goals", "lines"} else task["target"]
    scope = conversation_scope(task)
    return dict(course_id=course["id"], target=target, channel=channel, scope=scope,
                note_id=task["inputs"].get("note_id", "") if channel == "note_review" else "",
                restore_epoch=course.get("ai_epoch"),
                generation=node.get("conversation_generations", {}).get(scope) if channel == "learning" else None)


def require_current_conversation(task, course):
    expected = task.get("conversation_identity") or logical_identity(task)
    if logical_identity(task | dict(before=course)) != expected:
        raise Conflict("会话代次、资料范围或恢复状态已变化，旧原文保留但不会应用")


class ConversationDirectory:
    def __init__(self, store):
        self.store = store

    def claim(self, task, provider, legacy_thread=None):
        logical = logical_identity(task)
        if logical["channel"] == "learning" and not legacy_thread:
            node = next((node for node in task["before"]["nodes"] if node["id"] == task["target"]), None)
            legacy_thread = thread_for(task["before"], node) if node else None
        logical_key = _digest(logical)
        # The model is not part of the identity: resuming with a newly chosen model keeps the conversation.
        provider_key = [type(provider).__module__, type(provider).__qualname__]
        key = _digest([logical, provider_key])
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM ai_conversations WHERE id=?", (key,)).fetchone()
            if row is None:
                migrated = self._legacy_thread(connection, logical_key, logical, legacy_thread)
                connection.execute("INSERT INTO ai_conversations VALUES(?,?,?,?,?,?,?)",
                                   (key, task["course_id"], logical_key, json.dumps(logical), migrated, None, timestamp()))
                row = connection.execute("SELECT * FROM ai_conversations WHERE id=?", (key,)).fetchone()
            thread_id = self._available_thread(connection, row, task["id"])
            connection.execute("UPDATE ai_conversations SET owner_task=?,thread_id=?,updated_at=? WHERE id=?",
                               (task["id"], thread_id, timestamp(), key))
        if logical["channel"] not in PERSISTENT_CHANNELS:
            # One-shot prompts are self-contained; resuming would re-bill every earlier prompt.
            thread_id = None
        return dict(key=key, thread_id=thread_id, identity=logical, provider=provider_key)

    @staticmethod
    def _legacy_thread(connection, logical_key, logical, legacy_thread):
        if logical["channel"] != "learning":
            return None
        # Rows from before the model left the key carry the conversation forward.
        known = connection.execute("SELECT thread_id FROM ai_conversations WHERE logical_key=? "
                                   "ORDER BY updated_at DESC LIMIT 1", (logical_key,)).fetchone()
        return known["thread_id"] if known else legacy_thread

    @staticmethod
    def _available_thread(connection, row, task_id):
        if not row["owner_task"] or row["owner_task"] == task_id:
            return row["thread_id"]
        owner = connection.execute("SELECT state,body FROM ai_tasks WHERE id=?", (row["owner_task"],)).fetchone()
        if owner and owner["state"] == "superseded":
            # An explicitly abandoned uncertain turn may still run. Isolate its replacement.
            return row["thread_id"] if json.loads(owner["body"]).get("raw_reply") else None
        if owner and owner["state"] in {"applied", "invalid", "conflict"} and json.loads(owner["body"]).get("raw_reply"):
            return row["thread_id"]
        if owner and owner["state"] == "rejected" and not json.loads(owner["body"]).get("request"):
            return row["thread_id"]
        raise Conflict(f"同一学习会话仍由任务 {row['owner_task']} 占用，请先取回原轮次；未发送新请求")

    @staticmethod
    def bind(connection, task, thread_id):
        key = task.get("conversation_key")
        if not key:
            return True
        if task["state"] == "superseded":
            return False
        changed = connection.execute(
            "UPDATE ai_conversations SET thread_id=?,updated_at=? WHERE id=? AND owner_task=?",
            (thread_id, timestamp(), key, task["id"]),
        )
        return changed.rowcount == 1

    def finish(self, task):
        if not task.get("conversation_key") or (task.get("request") and not task.get("raw_reply")):
            return
        with self.store.connect() as connection:
            connection.execute("UPDATE ai_conversations SET owner_task=NULL,updated_at=? WHERE id=? AND owner_task=?",
                               (timestamp(), task["conversation_key"], task["id"]))

    def assert_send_allowed(self, connection, task):
        current = self.store.course(task["course_id"], connection)
        if (task["state"] == "superseded"
                or logical_identity(task | dict(before=current)) != logical_identity(task)):
            return False
        key = task.get("conversation_key")
        if not key:
            return True
        row = connection.execute("SELECT owner_task FROM ai_conversations WHERE id=?", (key,)).fetchone()
        return bool(row and row[0] == task["id"])

    def organization(self, task):
        with self.store.connect() as connection:
            row = connection.execute("SELECT body FROM codex_sidebar_evidence WHERE course_id=?",
                                     (task["course_id"],)).fetchone()
        evidence = json.loads(row[0]) if row else {}
        verified = task.get("thread_id") in evidence.get("thread_ids", [])
        return dict(native_status="failed" if task.get("organization_error") else task.get("native_organization", "unverified"),
                    native_section_id=task.get("native_section_id") or evidence.get("native_section_id"),
                    desktop_status="confirmed" if verified else "pending",
                    desktop_section_id=evidence.get("desktop_section_id"),
                    checked_at=evidence.get("checked_at") if verified else None,
                    automatic_sync_supported=False)

    def native_section(self, course_id):
        with self.store.connect() as connection:
            row = connection.execute("SELECT section_id FROM codex_native_groups WHERE course_id=?",
                                     (course_id,)).fetchone()
        return row[0] if row else None

    def send_guard(self):
        return conversation_send_gate(self.store)
