"""Capture the source identity at application creation, rather than at health reads."""

import hashlib
import os
from pathlib import Path

from .store import timestamp


def runtime_identity():
    digest = hashlib.sha256()
    for source in sorted(Path(__file__).parent.glob("*.py")):
        digest.update(source.name.encode())
        digest.update(source.read_bytes())
    return dict(started_at=timestamp(), pid=os.getpid(), source_fingerprint=digest.hexdigest(),
                recovery_contract=2, automatic_desktop_sync=False)
