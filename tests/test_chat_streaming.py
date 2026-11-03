"""The reply received so far is kept on the task so the chat can show it while it streams."""

from backend import ai_tasks
from backend.ai_tasks import ReceiptAI


class _Manager:
    def __init__(self):
        self.events, self.updates = [], []

    def event(self, task_id, event, payload):
        self.events.append(event)

    def update(self, task_id, **values):
        self.updates.append(values)


def _delta(text, item="a"):
    return {"method": "item/agentMessage/delta", "params": {"delta": text, "itemId": item}}


def test_partial_reply_is_flushed_and_throttled(monkeypatch):
    clock = iter([10.0, 10.1, 10.5, 11.0])
    monkeypatch.setattr(ai_tasks.time, "monotonic", lambda: next(clock))
    manager = _Manager()
    receipt = ReceiptAI(object(), manager, "task-1")
    receipt("stream/message", _delta("茶"))
    receipt("stream/message", _delta("≿"))
    receipt("stream/message", _delta("咖啡"))
    receipt("stream/message", _delta("第二段", item="b"))
    assert manager.updates == [{"partial_reply": "茶"}, {"partial_reply": "茶≿咖啡"},
                               {"partial_reply": "茶≿咖啡\n\n第二段"}]
    assert manager.events == ["stream/message"] * 4


def test_other_events_do_not_write_partial_reply():
    manager = _Manager()
    receipt = ReceiptAI(object(), manager, "task-1")
    receipt("stream/message", {"method": "item/started", "params": {"item": {"type": "agentMessage"}}})
    receipt("turn/sending", {})
    assert manager.updates == []
