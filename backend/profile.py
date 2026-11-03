from .domain import learning_profile
from .store import Conflict


def accept_stage(store, stage_id):
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        courses = store.active_courses(connection)
        settings = store.settings(connection)
        accepted = settings.get("accepted_stages", [])
        profile = learning_profile(courses, accepted)
        stage = next((s for s in profile["stages"] if s["id"] == stage_id), None)
        if stage is None:
            raise Conflict("评分批次已变化，请刷新档案后重新选择")
        if stage_id not in accepted:
            _apply_stage(store, connection, courses, stage)
            settings["accepted_stages"] = [*accepted, stage_id]
            store.save_settings(settings, connection)
        return learning_profile(courses, settings.get("accepted_stages", []))


def _apply_stage(store, connection, courses, stage):
    for course in courses:
        course["preferences"]["pace"] = stage["advice"]
        store.save_course(course, connection)
