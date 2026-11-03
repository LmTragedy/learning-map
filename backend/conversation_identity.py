"""Course and node identity used to name and group learning conversations."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ConversationIdentity:
    title: str
    group: str
    native_section_id: str | None = None
