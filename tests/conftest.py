"""Keep the module-level ASGI application's bootstrap database out of live data."""

import os
from uuid import uuid4

import pytest

_previous_data_root = pytest.StashKey[str | None]()


def pytest_configure(config):
    config.stash[_previous_data_root] = os.environ.get("LEARNING_MAP_DATA")
    os.environ["LEARNING_MAP_DATA"] = str(config.rootpath / "test-results" / f"bootstrap-{uuid4().hex}")


def pytest_unconfigure(config):
    previous = config.stash.get(_previous_data_root, None)
    if previous is None:
        os.environ.pop("LEARNING_MAP_DATA", None)
    else:
        os.environ["LEARNING_MAP_DATA"] = previous
