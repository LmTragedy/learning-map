import copy
import sqlite3

import pytest

from backend.domain import learning_profile
from backend.profile import accept_stage
from backend.store import Conflict, Store, identity, timestamp


@pytest.fixture
def graded_courses(tmp_path):
    store = Store(tmp_path / "data")
    first, second = store.create("数据库"), store.create("block_updates")
    with store.edit(first["id"]) as (course, _):
        course["ratings"] = [
            dict(
                id=identity(),
                node_id="source-node",
                attempt_id=identity(),
                created_at=timestamp(),
                problem=1,
                mastery=1,
                comment="需要具体例子",
            )
            for _ in range(10)
        ]
    stage = learning_profile(store.list_courses(), [])["stages"][0]
    return store, first["id"], second["id"], stage


def test_stage_applies_all_course_preferences_and_acceptance_in_one_transaction(graded_courses):
    store, first, second, stage = graded_courses
    profile = accept_stage(store, stage["id"])
    assert profile["stages"][0]["accepted"]
    assert store.course(first)["preferences"]["pace"] == stage["advice"]
    assert store.course(second)["preferences"]["pace"] == stage["advice"]
    revisions = [course["revision"] for course in store.list_courses()]
    accept_stage(store, stage["id"])
    assert [course["revision"] for course in store.list_courses()] == revisions


def test_second_course_write_failure_rolls_back_every_preference_and_acceptance(graded_courses):
    store, _, _, stage = graded_courses
    before = copy.deepcopy(store.list_courses())
    with store.connect() as connection:
        connection.executescript("""
            CREATE TRIGGER reject_second_update BEFORE UPDATE ON courses
            WHEN json_extract(NEW.body, '$.title') = 'block_updates'
            BEGIN SELECT RAISE(ABORT, 'simulated database write failure'); END;
        """)
    with pytest.raises(sqlite3.IntegrityError, match="simulated database write failure"):
        accept_stage(store, stage["id"])
    assert store.list_courses() == before
    assert stage["id"] not in store.settings().get("accepted_stages", [])


def test_stage_invalidated_by_course_removal_cannot_change_preferences(graded_courses):
    store, first, second, stage = graded_courses
    course = store.course(first)
    token = store.preview("delete", {}, course)
    store.archive(first, token)
    before = store.course(second)
    with pytest.raises(Conflict, match="评分批次已变化"):
        accept_stage(store, stage["id"])
    assert store.course(second) == before
