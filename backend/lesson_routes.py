from fastapi.responses import HTMLResponse

from .domain import find_node, project_course
from .lesson_html import LESSON_CSP
from .lessons import LessonRequest, find_lesson, generate_lesson, mark_lesson_read
from .review_scope import require_review_record


def register_lesson_routes(app, store, learning):
    @app.post("/api/courses/{cid}/nodes/{nid}/lessons")
    def generate(cid: str, nid: str, request: LessonRequest):
        return project_course(generate_lesson(learning, cid, nid, request))

    @app.get("/api/courses/{cid}/nodes/{nid}/lessons/{lid}/html")
    def html(cid: str, nid: str, lid: str, download: bool = False):
        course = store.course(cid)
        lesson = find_lesson(find_node(course, nid), lid)
        require_review_record(course, lesson)
        headers = {"Content-Security-Policy": LESSON_CSP, "X-Content-Type-Options": "nosniff"}
        if download:
            headers["Content-Disposition"] = f'attachment; filename="lesson-{lesson["id"]}.html"'
        return HTMLResponse(lesson["html"], headers=headers)

    @app.post("/api/courses/{cid}/nodes/{nid}/lessons/{lid}/read")
    def read(cid: str, nid: str, lid: str):
        return project_course(mark_lesson_read(store, cid, nid, lid))
