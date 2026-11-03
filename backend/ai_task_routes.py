"""Local receipt queries and explicit recovery/regeneration actions."""

from pathlib import Path

from fastapi.responses import JSONResponse
from pydantic import Field

from .ai_history import scan_bridge_history
from .ai_history_import import bridge_disposition, import_legacy_receipt
from .ai_legacy_history import scan_legacy_history
from .ai_tasks import client_request_id
from .bridge_backfill import backfill, fill_batch
from .domain import find_node, project_course
from .goal_routes import extract_goals
from .lessons import LessonRequest, generate_lesson
from .lines_ai import generate_lines, retell
from .material_indexing import build_index
from .node_links import find_links
from .note_review import ReviewInput
from .recall import summarize_recall
from .review_scope import require_review_node, scope_key, strict_scope
from .schemas import Input
from .store import Conflict, identity


class RegenerateRequest(Input):
    request_id: str = Field(min_length=16, max_length=80, pattern=r"^[a-zA-Z0-9-]+$")


class ConversationReset(Input):
    revision: int = Field(ge=0)


def register_ai_task_routes(app, store, learning):
    tasks = learning.tasks

    def owned(cid, tid):
        store.course(cid)
        task = tasks.get(tid)
        if task["course_id"] != cid:
            raise KeyError("AI 任务不属于这门课程")
        return task

    def historical_bridge(task, request_id):
        if task.get("history_matched") is False:
            raise Conflict("历史输出与课程输入未可靠匹配，只保留原文供核对")
        cid, inputs = task["course_id"], task["inputs"]
        course = store.course(cid)
        if bridge_disposition(task, course) in {"already_applied", "conflict"}:
            raise Conflict("当前知识桥已有内容，历史原文可查看但不会重复写入或覆盖")
        edges = {edge["id"]: edge for edge in course["edges"]}
        batch = [edges[edge_id] for edge_id in inputs["relation_ids"] if edge_id in edges]
        if len(batch) != len(inputs["relation_ids"]):
            raise Conflict("历史请求中的联系已改变，原始结果已保留")
        return tasks.run(cid, "bridge_history", task["target"], inputs,
                         lambda: fill_batch(store, learning, course, batch), request_id=request_id)

    def goals(cid, request_id):
        with client_request_id(request_id):
            return extract_goals(store, learning, cid)

    def dispatch(task, request_id=None):
        cid, nid, inputs = task["course_id"], task["target"], task["inputs"]
        rid = request_id or task["request_id"]
        handlers = {
            "bridge": lambda: backfill(store, learning, cid,
                store.course(cid)["revision"] if request_id else inputs["revision"],
                None if nid == "batch" else nid, rid),
            "bridge_history": lambda: historical_bridge(task, rid),
            "links": lambda: find_links(store, learning, cid, nid,
                store.course(cid)["revision"] if request_id else inputs["revision"], rid),
            "chat": lambda: learning.chat(cid, nid, inputs["message"], request_id=rid),
            "lesson": lambda: generate_lesson(learning, cid, nid,
                LessonRequest.model_validate(inputs | {"request_id": rid})),
            "map": lambda: learning.generate(cid, request_id=rid),
            "question": lambda: learning.question(cid, nid, request_id=rid),
            "assessment": lambda: learning.submit(store.course(cid), nid,
                inputs["submission"] | {"id": rid}, [Path(path) for path in inputs["image_paths"]]),
            "recall": lambda: summarize_recall(learning, cid, nid, request_id=rid),
            "lines": lambda: generate_lines(store, learning, cid, request_id=rid),
            "retell": lambda: retell(store, learning, cid, nid, inputs["text"], request_id=rid),
            "goals": lambda: goals(cid, rid),
            "material_index": lambda: build_index(store, learning, cid, inputs["indexed"], rid),
            "note_review": lambda: app.state.note_reviewer.check(cid, nid,
                ReviewInput.model_validate(inputs | {"request_id": rid,
                    "revision": inputs.get("revision", store.course(cid)["revision"])}), receipt_id=rid),
        }
        if task["kind"] not in handlers:
            raise Conflict("此任务类型尚无正式应用处理器；原始结果已保留")
        return handlers[task["kind"]]()

    @app.get("/api/courses/{cid}/ai-tasks")
    def list_tasks(cid: str):
        return tasks.list(cid)

    @app.post("/api/courses/{cid}/ai-tasks/import-history")
    def import_history(cid: str):
        course = store.course(cid)
        candidates = scan_bridge_history(Path.home() / ".codex" / "sessions",
                                         store.root / "ai-workspace", course)
        edge_ids = {edge["id"] for edge in course["edges"]}
        imported, unmatched = [], 0
        for candidate in candidates:
            if candidate["relation_ids"] and set(candidate["relation_ids"]).issubset(edge_ids):
                imported.append(tasks.public(tasks.import_bridge_history(cid, candidate)))
            else:
                unmatched += 1
        for candidate in scan_legacy_history(Path.home() / ".codex" / "sessions",
                                             store.root / "ai-workspace", store.list_courses()):
            if candidate["kind"] == "bridge_backfill":
                continue
            if cid in candidate["course_ids"]:
                imported.append(tasks.public(import_legacy_receipt(tasks, cid, candidate)))
            else:
                unmatched += 1
        return dict(tasks=imported, unmatched=unmatched)

    @app.get("/api/courses/{cid}/ai-tasks/{tid}")
    def detail(cid: str, tid: str):
        from .ai_result_refs import presented_result

        task = owned(cid, tid)
        # The full original course snapshot stays private; raw output is an explicit local query.
        return ({key: value for key, value in task.items() if key not in {"before", "context_hash"}}
                | presented_result(task, store.course(cid)) | tasks.public(task))

    @app.get("/api/courses/{cid}/ai-tasks/{tid}/result")
    def task_result(cid: str, tid: str):
        from .ai_result_refs import presented_result

        task = owned(cid, tid)
        recorded = presented_result(task, store.course(cid))
        return dict(result_ref=tasks.public(task).get("result_ref"), object=recorded.get("result_object"))

    @app.post("/api/courses/{cid}/ai-tasks/{tid}/collect")
    def collect(cid: str, tid: str):
        task = tasks.collect(owned(cid, tid))
        return dict(task=tasks.public(task), course=None)

    @app.post("/api/courses/{cid}/nodes/{nid}/conversations/reset")
    def reset_conversation(cid: str, nid: str, request: ConversationReset):
        with tasks.conversations.send_guard(), store.edit(cid, expected=request.revision) as (course, connection):
            node = find_node(course, nid)
            require_review_node(course, node)
            store.snapshot(course, "新开学习会话前自动备份", connection)
            key = scope_key(course)
            node.setdefault("conversation_generations", {})[key] = identity()
            if strict_scope(course):
                node.setdefault("review_threads", {}).pop(key, None)
            else:
                node["thread_id"] = None
        return project_course(store.course(cid))

    @app.get("/api/courses/{cid}/ai-tasks/{tid}/events")
    def events(cid: str, tid: str):
        owned(cid, tid)
        return tasks.events(tid)

    @app.post("/api/courses/{cid}/ai-tasks/{tid}/recover")
    def recover(cid: str, tid: str):
        task = owned(cid, tid)
        if task.get("parent_task_id"):
            parent = owned(cid, task["parent_task_id"])
            if parent["state"] == "superseded":
                raise Conflict("父任务已停用；子任务原始结果仍保留")
            result = recover(cid, parent["id"])
            if isinstance(result, JSONResponse):
                return result
            return dict(task=tasks.public(tasks.get(tid)), parent=result.get("task"),
                        course=result.get("course"), result=tasks.get(tid).get("result"))
        if task["state"] == "superseded":
            raise Conflict("课程已恢复，此任务只能查看，不能重新应用")
        if task["state"] == "applied":
            if task["kind"] == "note_review":
                tasks.validate_result_context(task, store.course(cid))
            return dict(task=tasks.public(task), course=project_course(store.course(cid)),
                        result=task.get("result") if task.get("result_type") == "value" else None)
        child_summaries = tasks.public(task).get("children", [])
        if task["kind"] in {"material_index", "recall"} and child_summaries and not task.get("raw_reply"):
            current_course = store.course(cid)
            try:
                tasks.validate_result_context(task, current_course)
            except (Conflict, ValueError, KeyError) as error:
                tasks.update(tid, state="conflict", error=str(error))
                raise
            child_tasks = []
            for summary in child_summaries:
                child = tasks.get(summary["id"])
                if child["state"] not in {"applied", "received"}:
                    child = tasks.collect(child)
                if child["state"] in {"applied", "received"}:
                    tasks.validate_result_context(child, current_course)
                child_tasks.append(child)
            if any(child["state"] not in {"applied", "received"} for child in child_tasks):
                latest = tasks.get(tid)
                return JSONResponse(dict(task=tasks.public(latest), course=None), status_code=202)
            tasks.update(tid, state="prepared", error=None)
            result = dispatch(tasks.get(tid))
            completed = tasks.get(tid)
            if completed["state"] != "applied":
                raise Conflict(completed.get("error") or "子任务结果已保留，但父任务尚未正式应用")
            return dict(task=tasks.public(completed), course=project_course(store.course(cid)), result=result)
        task = tasks.collect(task)
        if task.get("history_only"):
            raise Conflict("历史索引只提供原文与对象核对；缺少原始应用上下文，不会自动写入课程")
        if task["state"] == "applied":
            if task["kind"] == "note_review":
                tasks.validate_result_context(task, store.course(cid))
            return dict(task=tasks.public(task), course=project_course(store.course(cid)),
                        result=task.get("result") if task.get("result_type") == "value" else None)
        if not task.get("raw_reply"):
            return JSONResponse(dict(task=tasks.public(task), course=None), status_code=202)
        result = dispatch(task)
        completed = tasks.get(tid)
        if completed["state"] != "applied":
            raise Conflict(completed.get("error") or "原始结果已保留，但尚未正式应用")
        return dict(task=tasks.public(completed), course=project_course(store.course(cid)),
                    result=result if completed.get("result_type") == "value" else None)

    @app.post("/api/courses/{cid}/ai-tasks/{tid}/regenerate")
    def regenerate(cid: str, tid: str, request: RegenerateRequest):
        task = owned(cid, tid)
        if task.get("parent_task_id"):
            raise Conflict("子任务不能单独重新生成；请按父任务继续或重新开始")
        if tasks.public(task).get("history_only"):
            raise Conflict("历史原文索引不能作为新生成请求；原记录和已有内容均已保留")
        result = tasks.regenerate(task, dispatch, request.request_id)
        return result if task["kind"] in {"recall", "goals", "note_review"} else project_course(result)

    @app.post("/api/courses/{cid}/ai-tasks/{tid}/organize")
    def organize(cid: str, tid: str):
        from .conversation_identity import ConversationIdentity

        task = owned(cid, tid)
        label = task.get("request", {}).get("conversation")
        if not task.get("thread_id") or not label:
            raise Conflict("尚无可靠会话身份或归类标签")
        provider = learning.ai_factory(store.settings())
        try:
            section_id = provider.organize_thread(task["thread_id"], ConversationIdentity(**label))
        except RuntimeError as error:
            tasks.update(tid, organization_error=str(error))
            raise
        tasks.event(tid, "metadata/organized", dict(section_id=section_id))
        return tasks.public(tasks.get(tid))
