from .conversation_identity import ConversationIdentity


def conversation_label(course, node=None, purpose=None):
    labels = [" ".join(course["title"].split())]
    if node:
        labels.append(" ".join(node["title"].split()))
    if purpose:
        labels.append(purpose)
    return ConversationIdentity(title="｜".join(labels), group="学习 · " + labels[0])


def remember_conversation(course, thread_id, identity, node_id=None):
    record = dict(thread_id=thread_id, title=identity.title, group=identity.group, node_id=node_id)
    records = course.setdefault("codex_threads", [])
    for index, previous in enumerate(records):
        if previous["thread_id"] == thread_id:
            records[index] = record
            return
    records.append(record)
