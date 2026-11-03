"""Isolated synthetic API fixture for the first-phase AI task UI preview."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import uvicorn
from starlette.routing import Mount

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PREVIEW_ROOT = PROJECT_ROOT / "test-results" / "frontend-ai-ui" / "data"
PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
DEMO_REQUEST_IDS = [
    "preview-recovery-chat-0001", "preview-received-chat-0001",
    "preview-invalid-lesson-0001", "preview-valid-lesson-0001",
]
os.environ["LEARNING_MAP_DATA"] = str(PREVIEW_ROOT / "bootstrap")
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.app import create_app  # noqa: E402
from backend.lesson_routes import LessonRequest  # noqa: E402
from backend.lessons import generate_lesson  # noqa: E402
from backend.sample import create_sample  # noqa: E402
from backend.store import identity, timestamp  # noqa: E402


class PreviewProvider:
    """Deterministic provider; all model-shaped replies stay inside this file."""

    def __init__(self) -> None:
        self.ask_count = 0
        self.read_turn_count = 0
        self.fail_next_ask = False
        self.invalid_next_lesson = False

    def available(self) -> dict[str, bool]:
        return {"available": True, "test_boundary": True}

    def ask(self, _prompt: str, **options: object) -> dict[str, str]:
        self.ask_count += 1
        if self.fail_next_ask:
            self.fail_next_ask = False
            raise RuntimeError("预览数据：请求发出后连接中断")
        if self.invalid_next_lesson:
            self.invalid_next_lesson = False
            text = json.dumps({"synthetic": "malformed lesson draft"}, ensure_ascii=False)
        elif options.get("schema") is not None:
            text = json.dumps({
                "title": "预览小课：关系与主键",
                "goal": "理解关系与主键如何共同描述数据。",
                "html": "<p>把学生名单看成一张表，每一行代表一个学生，每一列代表一种信息。</p>",
                "check_question": "为什么学号适合作为主键？",
                "check_answer": "因为每个学生的学号都不同，可以唯一找到一行。",
                "recap": "关系由行和列组成，主键唯一标识一行。",
            }, ensure_ascii=False)
        else:
            text = "预览回复：主键可以唯一标识关系中的一行记录。"
        return {"text": text, "thread_id": "preview-thread", "turn_id": "preview-turn"}

    def read_turn(self, thread_id: str, turn_id: str | None = None, *, prompt: str | None = None) -> dict[str, str]:
        self.read_turn_count += 1
        if (thread_id, turn_id) != ("preview-existing-thread", "preview-existing-turn"):
            return {"status": "notFound", "text": "", "thread_id": thread_id, "turn_id": turn_id or ""}
        return {
            "status": "completed",
            "text": "预览恢复回复：外键引用另一张关系中的候选键。",
            "thread_id": thread_id,
            "turn_id": turn_id or "preview-turn-recovered",
        }

    def reset_counters(self) -> None:
        self.ask_count = 0
        self.read_turn_count = 0


def _context_hash(course: dict) -> str:
    encoded = json.dumps(course, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


@dataclass(frozen=True)
class TaskPreviewSeed:
    state: str
    message: str = "预览历史任务"
    kind: str = "chat"
    offset: int = 0
    raw_reply: str | None = None
    thread_id: str | None = None
    can_recover: bool = False
    can_regenerate: bool = True
    superseded_by: str | None = None
    request_id: str | None = None
    error: str | None = None


def _insert_task(store, course: dict, node_id: str, seed: TaskPreviewSeed) -> str:
    created = (datetime.now(UTC) - timedelta(minutes=seed.offset)).isoformat()
    task_id = identity()
    request_id = seed.request_id or f"preview-request-{identity()[:18]}"
    body = {
        "created_at": created,
        "request_id": request_id,
        "inputs": {"message": seed.message},
        "before": course,
        "context_hash": _context_hash(course),
        "can_recover": seed.can_recover,
        "can_regenerate": seed.can_regenerate,
        "superseded_by": seed.superseded_by,
    }
    if seed.error:
        body["error"] = seed.error
    if seed.raw_reply is not None:
        body["raw_reply"] = {"text": seed.raw_reply}
        body["request"] = {"prompt": "synthetic preview prompt"}
    if seed.thread_id:
        body["thread_id"] = seed.thread_id
        body["turn_id"] = "preview-turn-recovered"
    with store.connect() as connection:
        connection.execute(
            "INSERT INTO ai_tasks VALUES(?,?,?,?,?,?,?,?)",
            (task_id, course["id"], request_id, seed.kind, node_id, seed.state,
             json.dumps(body, ensure_ascii=False), timestamp()),
        )
    return task_id


def _preview_source(material: dict, quote: str) -> dict:
    return {
        "material_id": material["id"], "material_name": material["name"],
        "page": 1, "quote": quote[:110], "matched": False, "uncertain": True,
    }


def _preview_redraw(source: dict) -> dict:
    return {
        "id": identity(), "number": 2, "title": "合成重绘组件验收",
        "kind": "figure", "provenance": "redraw", "source": source,
        "diagram": {"width": 320, "height": 140, "elements": [
            {"id": "redraw-student", "type": "box", "x": 18, "y": 38, "width": 110, "height": 48, "text": "学生表"},
            {"id": "redraw-key", "type": "box", "x": 192, "y": 38, "width": 110, "height": 48, "text": "主键：学号"},
            {"id": "redraw-arrow", "type": "arrow", "x1": 128, "y1": 62, "x2": 192, "y2": 62, "label": "唯一标识"},
        ]},
    }


def _preview_invented_example() -> dict:
    return {
        "id": identity(), "number": 3, "title": "合成自编示例",
        "kind": "example", "provenance": "invented",
        "body": "合成组件测试，不代表课程生成结果",
        "explanation": "这里只检查 AI 自编来源标签的界面显示。",
    }


def _preview_process(source: dict) -> dict:
    return {
        "id": identity(), "number": 4, "title": "合成主键变化过程",
        "kind": "process", "provenance": "redraw", "source": source,
        "steps": [
            {
                "title": "开始：两个学生行", "changes": ["每一行表示一个学生。"],
                "reason": "先看关系的行结构。",
                "diagram": {"width": 320, "height": 140, "elements": [
                    {"id": "row-a", "type": "cell", "x": 20, "y": 22, "width": 130, "height": 36, "text": "学号 | 姓名"},
                    {"id": "row-b", "type": "cell", "x": 20, "y": 68, "width": 130, "height": 36, "text": "101 | 林"},
                ]},
            },
            {
                "title": "加入唯一学号", "changes": ["新列学号标识每一行。"],
                "reason": "唯一值让行可以被准确定位。",
                "diagram": {"width": 320, "height": 140, "elements": [
                    {"id": "row-a", "type": "cell", "x": 20, "y": 22, "width": 190, "height": 36, "text": "学号 | 姓名", "changed": True},
                    {"id": "row-b", "type": "cell", "x": 20, "y": 68, "width": 190, "height": 36, "text": "101 | 林"},
                ]},
            },
            {
                "title": "用学号找到一行", "changes": ["查询 101 会定位到对应学生。"],
                "reason": "主键用于唯一标识关系中的一行。",
                "diagram": {"width": 320, "height": 140, "elements": [
                    {"id": "row-b", "type": "cell", "x": 20, "y": 68, "width": 190, "height": 36, "text": "101 | 林", "changed": True},
                    {"id": "lookup", "type": "arrow", "x1": 225, "y1": 86, "x2": 284, "y2": 86, "label": "学号 101"},
                ]},
            },
        ],
    }


def _seed_lesson_visuals(store, course: dict) -> dict:
    current = store.course(course["id"])
    material = current["materials"][0]
    source = _preview_source(material, material["pages"][0]["text"])
    with store.edit(course["id"]) as (updated, _connection):
        lesson = next(
            record for node in updated["nodes"] for record in node.get("lessons", [])
            if record.get("request_id") == "preview-valid-lesson-0001"
        )
        lesson["visuals"] = [
            {
                "id": identity(), "number": 1, "title": "真实材料页预览（合成课程）",
                "kind": "figure", "provenance": "source", "source": source,
                "image_url": f"/api/courses/{course['id']}/materials/{material['id']}/pages/1",
            },
            _preview_redraw(source), _preview_invented_example(), _preview_process(source),
        ]
    return store.course(course["id"])


def _seed_course(app) -> dict:
    store, learning = app.state.store, app.state.learning
    course = create_sample(store)
    store.save_settings(store.settings() | {"ai_enabled": True})
    with store.edit(course["id"]) as (current, _connection):
        current["title"] = "合成验收课程 · 非生产"
    node_id = course["nodes"][0]["id"]
    generate_lesson(learning, course["id"], node_id, LessonRequest(
        request_id="preview-valid-lesson-0001", kind="initial", focus="",
    ))
    _seed_lesson_visuals(store, course)
    return store.course(course["id"])


def _seed_history(store, course: dict, node_id: str) -> None:
    for index in range(21):
        _insert_task(store, course, node_id, TaskPreviewSeed(
            state="superseded", message=f"合成历史任务 {index + 1}", offset=index + 5,
        ))


def _seed_interrupted_chat(learning, provider: PreviewProvider, course: dict, node_id: str) -> None:
    provider.fail_next_ask = True
    try:
        learning.chat(course["id"], node_id, "预览恢复任务：请解释外键。", request_id="preview-recovery-chat-0001")
    except RuntimeError:
        pass
    task = next(task for task in learning.tasks.list(course["id"]) if task["request_id"] == "preview-recovery-chat-0001")
    learning.tasks.update(task["id"], state="unknown", thread_id="preview-existing-thread", turn_id="preview-existing-turn")


def _seed_received_chat(learning, course: dict) -> None:
    store = learning.store
    original_save = store.save_course

    def fail_preview_save(*_args):
        store.save_course = original_save
        raise OSError("预览数据：模拟课程写入暂时失败")

    store.save_course = fail_preview_save
    node_id = course["nodes"][1]["id"]
    try:
        learning.chat(course["id"], node_id, "预览已回复未写入任务。", request_id="preview-received-chat-0001")
    except OSError:
        pass
    task = next(task for task in learning.tasks.list(course["id"]) if task["request_id"] == "preview-received-chat-0001")
    learning.tasks.update(task["id"], state="received", error=None)


def _seed_invalid_lesson(learning, course: dict, node_id: str, provider: PreviewProvider) -> None:
    provider.invalid_next_lesson = True
    try:
        generate_lesson(learning, course["id"], node_id, LessonRequest(
            request_id="preview-invalid-lesson-0001", kind="supplement", focus="辨认外键。",
        ))
    except ValueError:
        pass


def _seed_status_rows(store, course: dict, node_id: str) -> None:
    replacement_request_id = "preview-replacement-request-0001"
    _insert_task(store, course, node_id, TaskPreviewSeed(
        state="conflict", message="课程改变冲突任务", raw_reply="预览冲突回复。",
        thread_id="preview-conflict-thread", can_recover=False,
    ))
    _insert_task(store, course, node_id, TaskPreviewSeed(
        state="failed", message="生成失败的历史任务", error="预览数据：模拟后端原始错误。",
    ))
    _insert_task(store, course, node_id, TaskPreviewSeed(
        state="superseded", message="版本恢复取代的任务", superseded_by=replacement_request_id,
    ))
    _insert_task(store, course, node_id, TaskPreviewSeed(
        state="prepared", message="另行重新生成的新任务", request_id=replacement_request_id,
        can_recover=False, can_regenerate=False,
    ))
    _insert_task(store, course, node_id, TaskPreviewSeed(
        state="running", message="正在处理的任务", thread_id="preview-running-thread",
        can_recover=False, can_regenerate=False,
    ))


def _resolve_resume_dir(path: Path) -> Path:
    root = PREVIEW_ROOT.resolve(strict=True)
    resolved = path.resolve(strict=True)
    if resolved == root or not resolved.is_relative_to(root):
        raise ValueError(f"Resume directory must be inside {root}")
    database = (resolved / "learning.sqlite3").resolve(strict=True)
    if not database.is_relative_to(resolved) or not database.is_file():
        raise ValueError("Resume directory must contain its own learning.sqlite3 file")
    return resolved


def _load_preview_course(store) -> tuple[dict, str, str]:
    matches = [
        (course, node, lesson)
        for course in store.list_courses()
        for node in course["nodes"]
        for lesson in node.get("lessons", [])
        if lesson.get("request_id") == "preview-valid-lesson-0001"
    ]
    if len(matches) == 1:
        course, node, lesson = matches[0]
        return course, node["id"], lesson["id"]
    if len(matches) > 1:
        raise ValueError("Resume database must contain exactly one synthetic preview lesson")
    raise ValueError("Resume database is missing the seeded preview lesson")


def create_preview_app(resume_dir: Path | None = None):
    run_dir = _resolve_resume_dir(resume_dir) if resume_dir else (
        PREVIEW_ROOT / f"run-{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%f')}"
    )
    provider = PreviewProvider()
    app = create_app(run_dir, lambda _settings: provider)
    app.state.preview_provider = provider
    static_mounts = [route for route in app.router.routes if isinstance(route, Mount)]
    app.router.routes[:] = [route for route in app.router.routes if not isinstance(route, Mount)]
    store = app.state.store
    learning = app.state.learning
    if resume_dir:
        course, node_id, lesson_id = _load_preview_course(store)
    else:
        course = _seed_course(app)
        node_id = course["nodes"][0]["id"]
        _seed_history(store, course, node_id)
        _seed_interrupted_chat(learning, provider, course, node_id)
        _seed_received_chat(learning, course)
        _seed_invalid_lesson(learning, course, node_id, provider)
        _seed_status_rows(store, store.course(course["id"]), node_id)
        course, node_id, lesson_id = _load_preview_course(store)
    provider.reset_counters()

    audit: deque[dict[str, str | int]] = deque(maxlen=1000)

    @app.middleware("http")
    async def record_api_request(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            audit.append({"method": request.method, "path": request.url.path, "status": response.status_code})
        return response

    @app.get("/test/counters")
    def counters():
        return {"ask": provider.ask_count, "read_turn": provider.read_turn_count}

    @app.get("/test/audit")
    def request_audit():
        return {"requests": list(audit)}

    @app.get("/test/info")
    def preview_info():
        current_course, current_node_id, current_lesson_id = _load_preview_course(store)
        requests = {task["request_id"] for task in learning.tasks.list(current_course["id"])}
        return {
            "course_id": current_course["id"], "node_id": current_node_id, "lesson_id": current_lesson_id,
            "request_ids": [request_id for request_id in DEMO_REQUEST_IDS if request_id in requests],
        }

    app.state.preview = {
        "course_id": course["id"], "node_id": node_id, "lesson_id": lesson_id,
        "data_dir": str(run_dir),
    }
    app.router.routes.extend(static_mounts)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the isolated AI task API preview")
    parser.add_argument("--resume", type=Path, help="reuse an existing preview data directory under test-results")
    arguments = parser.parse_args()
    try:
        resume_dir = _resolve_resume_dir(arguments.resume) if arguments.resume else None
        app = create_preview_app(resume_dir)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    preview = app.state.preview
    print(f"Synthetic task preview: http://127.0.0.1:8766 (course {preview['course_id']}, node {preview['node_id']})")
    print(f"Isolated data: {preview['data_dir']}")
    uvicorn.run(app, host="127.0.0.1", port=8766, reload=False)


if __name__ == "__main__":
    main()
