"""A short OS lock covers turn writes and resets, never model waiting."""

import errno
import os
from contextlib import contextmanager

from .store import Conflict


class SendGateBusy(Conflict):
    """The gate was not acquired; no turn write or sending observer has run."""


@contextmanager
def conversation_send_gate(store):
    with (store.root / "ai-send.lock").open("a+b") as gate:
        gate.seek(0, os.SEEK_END)
        if gate.tell() == 0:
            gate.write(b"\0")
            gate.flush()
        gate.seek(0)
        _lock(gate)
        try:
            yield
        finally:
            _unlock(gate)


def _lock(gate):
    try:
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(gate.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(gate.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno not in {errno.EACCES, errno.EAGAIN}:
            raise
        raise SendGateBusy("会话正在开始发送或切换，请稍后重试；未重复发送") from error


def _unlock(gate):
    if os.name == "nt":
        import msvcrt

        gate.seek(0)
        msvcrt.locking(gate.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(gate.fileno(), fcntl.LOCK_UN)
