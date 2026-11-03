import importlib.util
import os
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import obsidian
from .ai import AIError, AIUnavailable, CodexAI
from .domain import (
    find_attempt,
    find_node,
    learning_profile,
    mark_node,
    project_course,
    record_rating,
    resolve_attempt,
)
from .files import (
    answer_images,
    discard_materials,
    import_uploads,
    material_by_id,
    material_original,
    material_page,
)
from .learning import Learning, recall_messages
from .lesson_routes import register_lesson_routes
from .profile import accept_stage as apply_stage
from .recall import summarize_recall
from .review_scope import question_for, require_review_record, set_review_scope, strict_scope
from .sample import create_sample
from .schemas import (
    CreateCourse,
    Mark,
    Message,
    NoteWrite,
    Rating,
    Resolve,
    RestorePreview,
    ReviewScope,
    Settings,
    Token,
)
from .store import Conflict, Store

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def create_app(data_dir=None, ai_factory=None):
    store = Store(Path(data_dir or os.environ.get("LEARNING_MAP_DATA", PROJECT_ROOT / "data")))
    factory = ai_factory or (
        lambda settings: CodexAI(store.root / "ai-workspace", settings["model"], settings["reasoning_effort"])
    )
    learning = Learning(store, factory)
    app = FastAPI(title="Learning Map", version="0.1.0")
    app.state.store, app.state.learning = store, learning
    _security(app)
    _errors(app)
    _course_routes(app, store, learning)
    _learning_routes(app, store, learning)
    register_lesson_routes(app, store, learning)
    _protection_routes(app, store)
    _settings_routes(app, store, factory)
    frontend = PROJECT_ROOT / "frontend" / "dist"
    if frontend.exists():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    return app


def _security(app):
    @app.middleware("http")
    async def local_only(request: Request, call_next):
        hostname = request.url.hostname
        if hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}:
            return JSONResponse({"detail": "只允许本机访问"}, status_code=403)
        origin = request.headers.get("origin")
        allowed_origin = f"{request.url.scheme}://{request.headers.get('host')}"
        if origin and origin != allowed_origin:
            return JSONResponse({"detail": "来源不匹配"}, status_code=403)
        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("x-learning-map") != "1":
            return JSONResponse({"detail": "缺少本机应用请求标记"}, status_code=403)
        length = request.headers.get("content-length", "0")
        if not length.isdigit() or int(length) > 110 * 1024 * 1024:
            return JSONResponse({"detail": "请求超过 110 MB 上限"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers.setdefault("Content-Security-Policy", (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
            "frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        ))
        return response


def _errors(app):
    @app.exception_handler(KeyError)
    async def missing(_, error):
        return JSONResponse({"detail": str(error.args[0])}, status_code=404)

    @app.exception_handler(Conflict)
    async def conflict(_, error):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.exception_handler(ValueError)
    async def invalid(_, error):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(AIError)
    @app.exception_handler(AIUnavailable)
    async def ai_error(_, error):
        return JSONResponse({"detail": str(error)}, status_code=503)


def _course_routes(app, store, learning):
    @app.get("/api/courses")
    def courses():
        return [
            dict(
                id=c["id"],
                title=c["title"],
                node_count=len(c["nodes"]),
                passed_count=sum(n["status"] == "passed" for n in c["nodes"]),
                material_count=len(c["materials"]),
                revision=c["revision"],
            )
            for c in store.list_courses()
        ]

    @app.post("/api/courses")
    def create(request: CreateCourse):
        return store.create(request.title)

    @app.post("/api/sample")
    def sample():
        return project_course(create_sample(store))

    @app.get("/api/courses/{course_id}")
    def course(course_id: str):
        return project_course(store.course(course_id))

    @app.post("/api/courses/{course_id}/materials")
    def upload(
        course_id: str, files: list[UploadFile] = File(...), week: str = Form(""), parser: str = Form("basic")
    ):
        if parser not in {"basic", "docling"} or len(week) > 100:
            raise ValueError("解析器或周次标识不正确")
        store.course(course_id)
        materials = import_uploads(store, course_id, files, dict(parser=parser, week=week))
        duplicates = []
        try:
            # Appending materials is safe on top of edits made while parsing, so no revision pin here.
            with store.edit(course_id) as (updated, _):
                known = {m["sha256"] for m in updated["materials"]}
                for material in materials:
                    if material["sha256"] in known:
                        duplicates.append(material)
                    else:
                        known.add(material["sha256"])
                        updated["materials"].append(material)
        except Exception:
            discard_materials(store, course_id, materials)
            raise
        discard_materials(store, course_id, duplicates)
        return project_course(store.course(course_id))

    @app.post("/api/courses/{course_id}/generate")
    def generate(course_id: str):
        return project_course(learning.generate(course_id))

    @app.post("/api/courses/{course_id}/review-scope")
    def review_scope(course_id: str, request: ReviewScope):
        with store.edit(course_id) as (current, _):
            set_review_scope(current, request.model_dump())
        return project_course(store.course(course_id))

    @app.get("/api/courses/{course_id}/materials/{material_id}/file")
    def original(course_id: str, material_id: str):
        material = material_by_id(store.course(course_id), material_id)
        return FileResponse(
            material_original(store, course_id, material_id),
            filename=material["name"],
            content_disposition_type="inline",
        )

    @app.get("/api/courses/{course_id}/materials/{material_id}/pages/{page_number}")
    def page(course_id: str, material_id: str, page_number: int):
        return FileResponse(
            material_page(store, store.course(course_id), material_id, page_number), media_type="image/png"
        )


def _learning_routes(app, store, learning):
    @app.post("/api/courses/{cid}/nodes/{nid}/mark")
    def mark(cid: str, nid: str, request: Mark):
        with store.edit(cid) as (course, _):
            mark_node(find_node(course, nid), request.status)
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/nodes/{nid}/chat")
    def chat(cid: str, nid: str, request: Message):
        return project_course(learning.chat(cid, nid, request.message))

    @app.get("/api/courses/{cid}/nodes/{nid}/recall")
    def recall(cid: str, nid: str, q: str = ""):
        course = store.course(cid)
        result = recall_messages(find_node(course, nid), q)
        if strict_scope(course):
            result["note"] += " 此处包含所有历史范围；AI 整理仅使用当前所选资料范围内的对话。"
        return result

    @app.post("/api/courses/{cid}/nodes/{nid}/recall-summary")
    def recall_summary(cid: str, nid: str):
        return summarize_recall(learning, cid, nid)

    @app.post("/api/courses/{cid}/nodes/{nid}/question")
    def question(cid: str, nid: str):
        return project_course(learning.question(cid, nid))

    @app.post("/api/courses/{cid}/nodes/{nid}/attempts")
    def attempt(
        cid: str,
        nid: str,
        answer: str = Form(""),
        reference: str = Form(""),
        files: list[UploadFile] = File(default=[]),
    ):
        current = store.course(cid)
        find_node(current, nid)
        if not answer.strip() and not files:
            raise ValueError("请输入作答或上传纸上作答文件")
        if len(answer) + len(reference) > 40000:
            raise ValueError("文字作答与参考答案合计不能超过 40,000 字符")
        attachments = import_uploads(store, cid, files, dict(parser="basic", week="纸上作答"))
        try:
            images = answer_images(store, current, attachments)
            submitted = dict(
                question=question_for(current, find_node(current, nid)) or {},
                answer=answer,
                reference=reference,
                attachments=attachments,
            )
            saved = learning.submit(current, nid, submitted, images)
        except Exception:
            discard_materials(store, cid, attachments)
            raise
        return project_course(saved)

    @app.post("/api/courses/{cid}/nodes/{nid}/attempts/{aid}/resolve")
    def resolve(cid: str, nid: str, aid: str, request: Resolve):
        with store.edit(cid) as (course, _):
            node = find_node(course, nid)
            attempt = find_attempt(node, aid)
            require_review_record(course, attempt)
            resolve_attempt(node, attempt, request.decision)
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/nodes/{nid}/attempts/{aid}/rating")
    def rating(cid: str, nid: str, aid: str, request: Rating):
        with store.edit(cid) as (course, _):
            node = find_node(course, nid)
            attempt = find_attempt(node, aid)
            require_review_record(course, attempt)
            record_rating(course, node, attempt, request.model_dump())
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/suggestions/{sid}/accept")
    def accept_suggestion(cid: str, sid: str):
        with store.edit(cid) as (course, _):
            suggestion = next((s for s in course["suggestions"] if s["id"] == sid), None)
            if suggestion is None:
                raise KeyError("建议不存在")
            course["preferences"]["pace"] = suggestion["advice"]
            suggestion["accepted"] = True
        return project_course(store.course(cid))


def _protection_routes(app, store):
    @app.get("/api/courses/{cid}/versions")
    def versions(cid: str):
        return store.versions(cid)

    @app.post("/api/courses/{cid}/snapshot")
    def snapshot(cid: str):
        with store.edit(cid) as (course, connection):
            store.snapshot(course, "手动保存", connection)
        return project_course(store.course(cid))

    @app.post("/api/courses/{cid}/restore-preview")
    def restore_preview(cid: str, request: RestorePreview):
        course = store.course(cid)
        with store.connect() as connection:
            target = store.version(cid, request.version_id, connection)
        token = store.preview("restore", request.model_dump(), course)
        return dict(
            token=token,
            target=f"{course['title']} / {request.version_id}",
            contents=[
                f"恢复 {len(target['nodes'])} 个节点、{len(target['materials'])} 份资料",
                "对话、验收、评分与课程设置一起恢复",
                "当前完整状态先保存为可回退版本",
            ],
            warning="恢复后保留历史副本；AI会话重新建立，仅使用恢复后的对话。",
        )

    @app.post("/api/courses/{cid}/restore")
    def restore(cid: str, request: Token):
        return project_course(store.restore(cid, request.token))

    @app.post("/api/courses/{cid}/delete-preview")
    def delete_preview(cid: str):
        course = store.course(cid)
        token = store.preview("delete", {}, course)
        return dict(
            token=token,
            target=course["title"],
            contents=[
                f"{len(course['materials'])} 份导入副本及纸上作答附件",
                f"{len(course['nodes'])} 个知识节点与全部对话/验收",
                f"{len(course['ratings'])} 次评分和课程学习档案",
                "全部地图版本",
            ],
            warning="确认后从课程列表移除并保留本地回收数据；绝不修改或删除外部原始文件。",
        )

    @app.post("/api/courses/{cid}/delete")
    def delete(cid: str, request: Token):
        store.archive(cid, request.token)
        return dict(deleted=True)


def _settings_routes(app, store, factory):
    @app.get("/api/health")
    def health():
        return dict(
            ai=factory(store.settings()).available(),
            data_dir=str(store.root),
            parser=dict(basic=True, docling=importlib.util.find_spec("docling") is not None),
        )

    @app.get("/api/settings")
    def settings():
        return {key: val for key, val in store.settings().items() if key != "accepted_stages"}

    @app.post("/api/settings")
    def update_settings(request: Settings):
        updated = store.settings() | request.model_dump()
        store.save_settings(updated)
        return settings()

    @app.get("/api/profile")
    def profile():
        return learning_profile(store.list_courses(), store.settings().get("accepted_stages", []))

    @app.post("/api/profile/stages/{stage_id}/accept")
    def accept_stage(stage_id: str):
        return apply_stage(store, stage_id)

    @app.get("/api/obsidian/notes")
    def notes(q: str = ""):
        return obsidian.notes(store, q)

    @app.post("/api/obsidian/preview")
    def preview(request: NoteWrite):
        return obsidian.preview_write(store, request.model_dump())

    @app.post("/api/obsidian/write")
    def write(request: Token):
        return obsidian.write_note(store, request.token)


app = create_app()
