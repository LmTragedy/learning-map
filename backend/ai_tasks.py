"""Durable generation receipts. Recovery reads a receipt; it never starts a turn."""

import hashlib
import json
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace

from .conversation_send_gate import SendGateBusy
from .conversation_sessions import ConversationDirectory, logical_identity, require_current_conversation
from .store import Conflict, identity, timestamp

_active = ContextVar("learning_map_ai_task", default=None)
_new_action = ContextVar("learning_map_new_generation", default=False)
_client_action = ContextVar("learning_map_client_action", default=None)
_regeneration_parent = ContextVar("learning_map_regeneration_parent", default=None)
CHILD_MODEL = "gpt-6-luna"
CHILD_EFFORT = "medium"


@dataclass(frozen=True)
class _Invocation:
    kind: str
    target: str
    inputs: dict
    course: dict
    request_key: str
    parent_task_id: str | None = None
    role: str | None = None
    model: str | None = None
    effort: str | None = None


@contextmanager
def client_request_id(request_id):
    token = _client_action.set(request_id)
    try:
        yield
    finally:
        _client_action.reset(token)


def requested_action_id():
    return _client_action.get()


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value):
    return hashlib.sha256(_encoded(value).encode()).hexdigest()


def current_task_id():
    task = _active.get()
    return task[1] if task else None


def is_regenerating():
    return _new_action.get()


def has_saved_reply():
    task = _active.get()
    return bool(task and task[0].get(task[1]).get("raw_reply"))


def task_ai(provider, settings=None):
    task = _active.get()
    if task and settings is not None:
        task[0].update(task[1], model=settings["model"], effort=settings["reasoning_effort"])
    return ReceiptAI(provider, *task) if task else provider


def save_task_result(connection, result):
    task = _active.get()
    if task:
        task[0].update(task[1], connection=connection, result=result, result_type="value")


def complete_task_value(result, connection=None):
    task = _active.get()
    if task:
        task[0].complete_value(task[1], result, connection)
    return result


class ReceiptAI:
    def __init__(self, provider, manager, task_id):
        self.provider, self.manager, self.task_id = provider, manager, task_id

    def ask(self, prompt, **options):
        # A conversation turn may offer a self-contained prompt for when no thread can be resumed.
        fresh_prompt = options.pop("fresh_prompt", None) or prompt
        task = self.manager.get(self.task_id)
        if task.get("raw_reply"):
            if (task.get("request", {}).get("prompt") not in (prompt, fresh_prompt)
                    or task.get("request", {}).get("schema") != options.get("schema")):
                raise Conflict("恢复输入与原请求不一致；原始结果已保留")
            return task["raw_reply"]
        if task["state"] != "prepared":
            raise Conflict(f"任务 {self.task_id} 状态待确认；请查询原任务，未重新生成")
        session = self.manager.conversations.claim(task, self.provider, options.get("thread_id"))
        if session["thread_id"]:
            options["thread_id"] = session["thread_id"]
        else:
            options.pop("thread_id", None)
            prompt = fresh_prompt
        label = options.get("conversation")
        if label:
            options["conversation"] = replace(label, native_section_id=self.manager.conversations.native_section(task["course_id"]))
        request = dict(prompt=prompt, schema=options.get("schema"), thread_id=options.get("thread_id"),
                       prompt_chars=len(prompt))
        if label:
            request["conversation"] = dict(title=label.title, group=label.group)
        self.manager.update(self.task_id, state="sending", request=request,
                            conversation_key=session["key"], conversation_identity=session["identity"])
        # Only the native adapter supports stream receipts; boundary fakes remain simple.
        from .ai import CodexAI
        if isinstance(self.provider, CodexAI):
            options["observer"] = self
        try:
            reply = self.provider.ask(prompt, **options)
        except SendGateBusy as error:
            self.manager.update(self.task_id, state="rejected", unsent_request=request, request=None, error=str(error))
            raise
        except (RuntimeError, OSError, ValueError) as error:
            self.manager.update(self.task_id, state="unknown", error=str(error))
            raise
        self.manager.receive(self.task_id, reply)
        return reply

    def __call__(self, event, payload):
        self.manager.event(self.task_id, event, payload)

    def send_guard(self):
        return self.manager.conversations.send_guard()


class TaskManager:
    def __init__(self, store, ai_factory):
        self.store, self.ai_factory = store, ai_factory
        self.conversations = ConversationDirectory(store)

    def reconcile_startup(self):
        # A new service instance cannot prove an old worker is still observing its turn.
        # Other live workers may still finish; unknown never authorizes a second send.
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                "SELECT id FROM ai_tasks WHERE state IN ('prepared','sending','running','processing')",
            ).fetchall()
            for row in rows:
                task = self.get(row[0], connection)
                state = "received" if task.get("raw_reply") else "unknown"
                if not task.get("request"):
                    state = "rejected"
                self.update(row[0], connection=connection,
                            state=state,
                            error="服务重新连接；请查询原任务，未重新生成")

    def get(self, task_id, connection=None):
        if connection is None:
            with self.store.connect() as opened:
                return self.get(task_id, opened)
        row = connection.execute("SELECT * FROM ai_tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise KeyError("AI 任务不存在")
        return json.loads(row["body"]) | {key: row[key] for key in
               ("id", "course_id", "kind", "target", "state", "updated_at")}

    def update(self, task_id, *, state=None, connection=None, **values):
        if connection is None:
            with self.store.connect() as opened:
                opened.execute("BEGIN IMMEDIATE")
                return self.update(task_id, state=state, connection=opened, **values)
        task = self.get(task_id, connection)
        # An old worker must never revive a restored or already applied task.
        if task["state"] in {"applied", "superseded"}:
            state = task["state"]
        task.update(values)
        connection.execute("UPDATE ai_tasks SET state=?,body=?,updated_at=? WHERE id=?",
                           (state or task["state"], _encoded(task), timestamp(), task_id))

    def event(self, task_id, event, payload):
        allowed = True
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("INSERT INTO ai_task_events(task_id,body) VALUES(?,?)",
                               (task_id, _encoded(dict(event=event, payload=payload))))
            values = {}
            if event == "thread/opened":
                values["thread_id"] = payload.get("thread_id")
            elif event == "turn/identified":
                values["turn_id"] = payload.get("turn_id")
            elif event == "metadata/failed":
                values["organization_error"] = payload.get("error", str(payload))
                values["native_organization"] = "failed"
            elif event == "metadata/organized":
                values.update(native_organization="confirmed", native_section_id=payload.get("section_id"),
                              organization_error=None)
                if payload.get("section_id"):
                    connection.execute("INSERT OR REPLACE INTO codex_native_groups VALUES(?,?)",
                                       (self.get(task_id, connection)["course_id"], payload["section_id"]))
            elif event == "response/completed":
                values.update(raw_reply=payload, thread_id=payload.get("thread_id"),
                              turn_id=payload.get("turn_id"))
            if values:
                self.update(task_id, connection=connection,
                            state="received" if event == "response/completed" else None, **values)
            task = self.get(task_id, connection)
            if event == "thread/opened":
                allowed = self.conversations.bind(connection, task, payload["thread_id"])
            elif event == "turn/sending":
                allowed = self.conversations.assert_send_allowed(connection, task)
        if not allowed:
            raise Conflict("会话已被恢复或切换，原线程身份已保存，未发送新轮次")

    def receive(self, task_id, reply):
        self.update(task_id, state="received", raw_reply=reply, thread_id=reply.get("thread_id"),
                    turn_id=reply.get("turn_id") or self.get(task_id).get("turn_id"), error=None)
        with self.store.connect() as connection:
            self.conversations.bind(connection, self.get(task_id, connection), reply.get("thread_id"))

    # Keep the shared use-case adapter signature; replace with a DTO if another option is added.
    def run(self, course_id, kind, target, inputs, action, request_id=None):
        if _active.get():
            return action()
        course = self.store.course(course_id)
        key = request_id or requested_action_id() or identity()
        task, fresh = self._reserve(_Invocation(kind, target, inputs, course, key))
        if task["state"] == "applied":
            return self.saved_result(task)
        has_child_receipts = (task.get("parent_task_id") is None and task.get("kind") in
                              {"material_index", "recall"} and bool(self._child_rows(task["id"])))
        if not fresh and has_child_receipts:
            self.validate_result_context(task, course)
        elif not fresh:
            self._prepare_replay(task, course)
        return self._execute(task, action)

    def _child_rows(self, parent_task_id, connection=None):
        if connection is None:
            with self.store.connect() as opened:
                return self._child_rows(parent_task_id, opened)
        return [self.get(row[0], connection) for row in connection.execute(
            "SELECT id FROM ai_tasks WHERE json_extract(body,'$.parent_task_id')=? ORDER BY rowid",
            (parent_task_id,),
        )]

    def run_child(self, course_id, role, inputs, action):
        """Create a frozen Luna-medium receipt; an active parent task is required."""
        parent = _active.get()
        if not parent or parent[0] is not self:
            raise Conflict("Luna 子任务必须由活动中的父任务显式调度")
        parent_task_id = parent[1]
        invocation = self._child_invocation(course_id, role, inputs, parent_task_id)
        task, fresh = self._reserve(invocation)
        if task.get("parent_task_id") != parent_task_id or task.get("role") != role:
            raise Conflict("子任务身份与冻结输入不一致")
        if task["state"] == "applied":
            self.validate_result_context(task, invocation.course)
            self.update(parent_task_id, state="received")
            return task["result"]
        if not fresh:
            self._prepare_replay(task, invocation.course)
        return self._execute_child(task, parent_task_id, action)

    def _child_invocation(self, course_id, role, inputs, parent_task_id):
        frozen_inputs = json.loads(_encoded(inputs))
        digest = _hash(dict(parent=parent_task_id, role=role, inputs=frozen_inputs,
                            model=CHILD_MODEL, effort=CHILD_EFFORT))
        return _Invocation("child", digest[:32], frozen_inputs, self.store.course(course_id),
                           f"child-{digest}", parent_task_id=parent_task_id, role=role,
                           model=CHILD_MODEL, effort=CHILD_EFFORT)

    def _execute_child(self, task, parent_task_id, action):
        child_context = (self, task["id"])
        token = _active.set(child_context)
        try:
            child_result = action()
            self._complete_child(task["id"], parent_task_id, child_result)
            return child_result
        except Exception as error:
            self._record_child_failure(task["id"], error)
            raise
        finally:
            try:
                self.conversations.finish(self.get(task["id"]))
            finally:
                _active.reset(token)

    def _complete_child(self, child_id, parent_task_id, child_result):
        child = self.get(child_id)
        if child["state"] != "applied":
            if child.get("raw_reply"):
                self.complete_value(child_id, child_result)
            else:
                self.update(child_id, state="invalid", error="子任务没有产生可应用的独立结果")
        if self.get(child_id)["state"] == "applied":
            # Parent course writes still use the standard received -> applied boundary.
            self.update(parent_task_id, state="received")

    def _record_child_failure(self, child_id, error):
        latest = self.get(child_id)
        state = "unknown" if latest.get("request") and not latest.get("raw_reply") else "invalid"
        if not latest.get("request"):
            state = "rejected"
        elif latest.get("raw_reply"):
            state = "received"
        self.update(child_id, state=state, error=str(error))

    def _reserve(self, invocation):
        course_id = invocation.course["id"]
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT id FROM ai_tasks WHERE course_id=? AND request_key=?",
                                     (course_id, invocation.request_key)).fetchone()
            if not row and not _new_action.get():
                row = self._pending(invocation, connection)
            if row:
                task = self.get(row["id"], connection)
                if ((task["kind"], task["target"]) != (invocation.kind, invocation.target)
                        or not self._same_inputs(invocation.kind, task["inputs"], invocation.inputs)):
                    raise Conflict("request_id 已用于其他输入，请保留原任务身份")
                fresh = task["state"] == "rejected" and not task.get("request")
                if fresh:
                    self.update(task["id"], state="prepared", connection=connection,
                                before=invocation.course, context_hash=_hash(invocation.course), error=None)
                    task = self.get(task["id"], connection)
            else:
                task = self._create(invocation, connection)
                fresh = True
        return task, fresh

    def _pending(self, invocation, connection):
        pending_rows = connection.execute(
            "SELECT id FROM ai_tasks WHERE course_id=? AND kind=? AND target=? "
            "AND state NOT IN ('applied','superseded','rejected') ORDER BY rowid DESC",
            (invocation.course["id"], invocation.kind, invocation.target),
        ).fetchall()
        for pending in pending_rows:
            previous = self.get(pending[0], connection)
            if (invocation.kind == "note_review"
                    and previous["inputs"].get("note_id", "") != invocation.inputs.get("note_id", "")):
                continue
            current = dict(before=invocation.course, kind=invocation.kind,
                           target=invocation.target, inputs=invocation.inputs)
            if logical_identity(previous) != logical_identity(current):
                continue
            settings = self.store.settings(connection)
            model = settings["note_review_model"] if invocation.kind == "note_review" else settings["model"]
            if previous.get("model") is not None and previous["model"] != model:
                continue
            raise Conflict(f"任务 {pending[0]} 尚待处理，请先恢复原请求或明确选择重新生成；新动作未冒用旧身份")
        return None

    @staticmethod
    def _same_inputs(kind, before, current):
        if kind == "note_review":
            ignored = {"revision", "request_id"}
            before = {key: value for key, value in before.items() if key not in ignored}
            current = {key: value for key, value in current.items() if key not in ignored}
        return before == current

    def _create(self, invocation, connection):
        task_id = identity()
        body = dict(inputs=invocation.inputs, before=invocation.course, context_hash=_hash(invocation.course),
                    created_at=timestamp(), request_id=invocation.request_key,
                    regenerated_from=_regeneration_parent.get(), parent_task_id=invocation.parent_task_id,
                    role=invocation.role, model=invocation.model, effort=invocation.effort)
        connection.execute("INSERT INTO ai_tasks VALUES(?,?,?,?,?,?,?,?)",
                           (task_id, invocation.course["id"], invocation.request_key, invocation.kind,
                            invocation.target, "prepared", _encoded(body), timestamp()))
        return self.get(task_id, connection)

    def _prepare_replay(self, task, course):
        if task["state"] == "superseded":
            raise Conflict(f"任务 {task['id']} 已停用，原始结果仍保留")
        if not task.get("raw_reply"):
            raise Conflict(f"任务 {task['id']} 尚无完整收据，请查询/恢复原任务；未重新生成")
        try:
            self.validate_result_context(task, course)
        except (ValueError, KeyError) as error:
            self.update(task["id"], state="conflict", error=str(error))
            raise
        self.update(task["id"], state="received")

    def validate_result_context(self, task, course, connection=None):
        require_current_conversation(task, course)
        if task["kind"] == "note_review":
            from .note_review import review_identity

            note_id = task["inputs"].get("note_id", "")
            original = review_identity(task["before"], task["target"], note_id)
            current = review_identity(course, task["target"], note_id)
            model = self.store.settings(connection)["note_review_model"].strip()
            if original != current or (task.get("model") and task["model"] != model):
                raise Conflict("笔记检查的来源、范围、模型或学习上下文已变化，原始结果已保留")
        elif _hash(course) != task["context_hash"]:
            raise Conflict("课程上下文已改变，原始结果已保留；未重新生成或应用")

    def saved_result(self, task):
        if task["kind"] == "note_review":
            self.validate_result_context(task, self.store.course(task["course_id"]))
        return task["result"] if task.get("result_type") == "value" else self.store.course(task["course_id"])

    def _execute(self, task, action):
        token = _active.set((self, task["id"]))
        try:
            result = action()
            if self.get(task["id"])["state"] != "applied":
                latest = self.get(task["id"])
                children = self._child_rows(task["id"])
                if children and all(child["state"] in {"applied", "received"} for child in children):
                    state = "received"
                elif any(child["state"] == "unknown" for child in children):
                    state = "unknown"
                else:
                    state = "unknown" if latest.get("request") and not latest.get("raw_reply") else "invalid"
                if not latest.get("request") and not children:
                    state = "rejected"
                self.update(task["id"], state=state,
                            error=latest.get("error") or "操作未正式应用；原始结果仍保留")
            return result
        except Exception as error:
            latest = self.get(task["id"])
            if latest["state"] == "applied" and isinstance(error, Conflict):
                return self.saved_result(latest)
            state = "conflict" if isinstance(error, Conflict) else "invalid"
            children = self._child_rows(task["id"])
            if children and all(child["state"] in {"applied", "received"} for child in children):
                state = "received"
            elif any(child["state"] == "unknown" for child in children):
                state = "unknown"
            elif not latest.get("raw_reply") and latest.get("request"):
                state = "unknown"
            elif not latest.get("request") and not children:
                state = "rejected"
            self.update(task["id"], state=state, error=str(error))
            raise
        finally:
            try:
                self.conversations.finish(self.get(task["id"]))
            finally:
                _active.reset(token)

    def list(self, course_id):
        self.store.course(course_id)
        with self.store.connect() as connection:
            rows = connection.execute("SELECT id FROM ai_tasks WHERE course_id=? ORDER BY rowid DESC", (course_id,))
            return [self.public(self.get(row[0], connection)) for row in rows]

    def find_request(self, course_id, request_id):
        if request_id is None:
            return None
        with self.store.connect() as connection:
            row = connection.execute("SELECT id FROM ai_tasks WHERE course_id=? AND request_key=?",
                                     (course_id, request_id)).fetchone()
            return self.get(row[0], connection) if row else None

    def find_original(self, course_id, thread_id, turn_id, connection):
        rows = connection.execute(
            "SELECT id FROM ai_tasks WHERE course_id=? AND json_extract(body,'$.thread_id')=? "
            "AND json_extract(body,'$.turn_id')=?", (course_id, thread_id, turn_id),
        ).fetchall()
        if len(rows) > 1:
            raise Conflict("同一原始轮次存在多个本地映射，已保留记录供核对")
        return self.get(rows[0][0], connection) if rows else None

    def import_bridge_history(self, course_id, candidate):
        from .bridge_backfill import BackfillDraft
        from .conversation_labels import conversation_label
        from .learning import _strict_output_schema

        key = "history-" + candidate["thread_id"] + "-" + candidate["turn_id"]
        previous = self.find_request(course_id, key)
        if previous:
            return previous
        with self.store.connect() as connection:
            rows = connection.execute("SELECT id FROM ai_tasks WHERE course_id=?", (course_id,)).fetchall()
            for row in rows:
                recorded = self.get(row[0], connection)
                if (recorded.get("thread_id"), recorded.get("turn_id")) == (
                        candidate["thread_id"], candidate["turn_id"]):
                    return recorded
        course = self.store.course(course_id)
        matched = candidate["matched"] and not course.get("ai_epoch")
        label = conversation_label(course, purpose="补充知识桥")
        body = dict(
            before=course, context_hash=_hash(course), created_at=timestamp(), request_id=key,
            inputs=dict(revision=course["revision"], relation_ids=candidate["relation_ids"]),
            request=dict(prompt=candidate["prompt"], schema=_strict_output_schema(BackfillDraft.model_json_schema()),
                         conversation=dict(title=label.title, group=label.group)),
            thread_id=candidate["thread_id"], turn_id=candidate["turn_id"],
            history_status=candidate["status"], history_matched=matched,
            error=("课程发生过恢复，未登记轮次只保留核对，不重新应用" if course.get("ai_epoch")
                   else candidate["match_error"]),
        )
        if candidate.get("raw_reply"):
            body["historical_raw"] = candidate["raw_reply"]
        if matched:
            body["raw_reply"] = dict(text=candidate["raw_reply"], thread_id=candidate["thread_id"],
                                     turn_id=candidate["turn_id"])
        with self.store.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("INSERT OR IGNORE INTO ai_tasks VALUES(?,?,?,?,?,?,?,?)",
                               (identity(), course_id, key, "bridge_history", candidate["turn_id"],
                                "received" if matched else "unknown", _encoded(body), timestamp()))
        return self.find_request(course_id, key)

    def public(self, task):
        from .ai_result_refs import presented_result

        published = {key: value for key, value in task.items() if key not in
                     {"before", "request", "unsent_request", "raw_reply", "historical_raw", "inputs", "context_hash", "result", "result_object"}}
        projection = presented_result(task, self.store.course(task["course_id"]))
        if task["kind"] == "note_review" and projection.get("result_ref"):
            try:
                self.validate_result_context(task, self.store.course(task["course_id"]))
            except (ValueError, KeyError):
                projection["result_ref"]["available"] = False
        published["result_ref"] = projection.get("result_ref")
        published.update({key: value for key, value in projection.items() if key != "result_object"})
        published.update(has_raw_reply=bool(task.get("raw_reply") or task.get("historical_raw")),
                         can_collect=bool(task.get("thread_id") and not task.get("raw_reply")),
                         organization=self.conversations.organization(task))
        if task.get("parent_task_id"):
            published["can_regenerate"] = False
        if task.get("parent_task_id") is None:
            with self.store.connect() as connection:
                published["children"] = [
                    {key: child.get(key) for key in ("id", "role", "state", "model", "effort", "error")}
                    | {"can_collect": bool(child.get("thread_id") and not child.get("raw_reply"))}
                    for child in self._child_rows(task["id"], connection)
                ]
            if task.get("kind") in {"material_index", "recall"} and not task.get("raw_reply"):
                published["can_recover"] = task["state"] != "applied" and any(
                    child["state"] in {"applied", "received"} or child.get("can_collect")
                    for child in published["children"]
                )
        if task.get("history_only"):
            published.update(can_recover=False, can_regenerate=False)
        if task["kind"] == "bridge_history":
            from .ai_history_import import bridge_disposition

            disposition = bridge_disposition(task, self.store.course(task["course_id"]))
            published["history_disposition"] = disposition
            if task["state"] != "applied" and disposition in {"already_applied", "conflict", "unmatched"}:
                published.update(state="archived", history_only=True, history_kind="bridge",
                                 can_recover=False, can_regenerate=False,
                                 history_match_reason={"already_applied": "原文内容已逐条对应到课程知识桥",
                                     "conflict": "原文与当前已有知识桥不同，保留原文且不覆盖",
                                     "unmatched": "原轮次未完整完成或请求匹配不明"}[disposition])
        return published

    def events(self, task_id):
        with self.store.connect() as connection:
            return [json.loads(row[0]) for row in connection.execute(
                "SELECT body FROM ai_task_events WHERE task_id=? ORDER BY sequence", (task_id,))]

    def complete_value(self, task_id, result, connection=None):
        if connection is None:
            with self.store.connect() as opened:
                opened.execute("BEGIN IMMEDIATE")
                return self.complete_value(task_id, result, opened)
        task = self.get(task_id, connection)
        if task["state"] != "received" or not task.get("raw_reply"):
            raise Conflict("任务没有可正式处理的完整结果")
        self.validate_result_context(task, self.store.course(task["course_id"], connection), connection)
        from .ai_result_refs import result_record

        record = result_record(task | dict(result_type="value", result=result),
                               self.store.course(task["course_id"], connection))
        self.update(task_id, state="applied", connection=connection,
                    result_type="value", result=result, error=None, **record)

    def collect(self, task):
        """Read the exact original turn. No AI consent is needed to read local history."""
        if task.get("raw_reply") or (task["state"] == "applied" and not task.get("history_only")):
            return task
        if task["kind"] == "bridge_history" and not task.get("history_matched"):
            return task
        if not task.get("thread_id"):
            self.update(task["id"], state="unknown", error="未取得会话身份，无法安全匹配历史结果")
            return self.get(task["id"])
        provider = self.ai_factory(self.store.settings())
        if not hasattr(provider, "read_turn"):
            self.update(task["id"], state="unknown", error="当前适配器不支持只读历史查询")
            return self.get(task["id"])
        try:
            reply = provider.read_turn(task["thread_id"], task.get("turn_id"),
                                       prompt=task.get("request", {}).get("prompt"))
        except (RuntimeError, OSError, ValueError) as error:
            self.update(task["id"], state="unknown", error=f"只读历史查询失败：{error}")
            raise
        if reply.get("status") == "completed" and reply.get("text"):
            self.receive(task["id"], reply)
            self.conversations.finish(self.get(task["id"]))
            if task.get("history_only"):
                self.update(task["id"], state="archived", history_status="completed", history_disposition="recovered")
        else:
            self.update(task["id"], state="archived" if task.get("history_only") else
                        "running" if reply.get("status") == "inProgress" else "unknown",
                        error="原任务尚未确认完整完成", turn_id=reply.get("turn_id"))
        return self.get(task["id"])

    def regenerate(self, task, dispatch, request_id):
        if request_id == task["request_id"]:
            raise Conflict("重新生成需要新的动作身份")
        previous = self.find_request(task["course_id"], request_id)
        if previous:
            if previous.get("regenerated_from") != task["id"]:
                raise Conflict("此重新生成身份已用于其他任务")
            if previous["state"] == "applied":
                return self.saved_result(previous)
            return dispatch(previous)
        self.update(task["id"], state="superseded", superseded_by=request_id,
                    error="用户明确选择重新生成；原始收据保留供查看")
        token = _new_action.set(True)
        parent_token = _regeneration_parent.set(task["id"])
        try:
            return dispatch(task, request_id)
        finally:
            _regeneration_parent.reset(parent_token)
            _new_action.reset(token)
