import os
from pathlib import Path

from .store import Conflict


def vault_root(store):
    configured = store.settings()["obsidian_vault"]
    if not configured:
        raise ValueError("请先在设置中填写本地 Obsidian 库目录")
    try:
        root = Path(configured).resolve(strict=True)
    except (FileNotFoundError, PermissionError) as error:
        raise ValueError("无法读取所选笔记库，请检查目录是否存在及本机读取权限") from error
    if not root.is_dir():
        raise ValueError("笔记库应为现有目录")
    return root


def note_target(root, relative):
    requested = Path(relative)
    if requested.is_absolute() or requested.drive or ".." in requested.parts:
        raise ValueError("笔记路径必须位于所选库内")
    if ":" in relative or requested.suffix.lower() != ".md":
        raise ValueError("只允许写入 Markdown 笔记")
    target = (root / requested).resolve()
    if not target.is_relative_to(root) or not target.parent.is_dir():
        raise ValueError("目标必须在库内已有目录中，不能通过链接越界")
    return target


def notes(store, query):
    root = vault_root(store)
    matches = []
    # Bounds protect both privacy (hidden files) and responsiveness on a large vault.
    for index, path in enumerate(root.rglob("*.md")):
        if index >= 5000 or len(matches) >= 30:
            break
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if not path.resolve().is_relative_to(root) or path.stat().st_size > 100000:
            continue
        content = path.read_text(encoding="utf-8-sig", errors="replace")
        if (
            not query
            or query.casefold() in content.casefold()
            or query.casefold() in str(relative).casefold()
        ):
            matches.append(dict(path=str(relative), content=content))
    return matches


def preview_write(store, request):
    root = vault_root(store)
    target = note_target(root, request["path"])
    if target.exists():
        raise Conflict("目标笔记已存在，本版只新增笔记；请换一个文件名，原笔记未修改")
    body = dict(vault=str(root), target=str(target), content=request["content"])
    return dict(
        token=store.preview("obsidian", body),
        target=str(target),
        content=request["content"],
        warning="确认后仅创建这份新笔记，不会自动改写已有笔记。",
    )


def write_note(store, token):
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        request = store.consume(token, "obsidian", connection)
        root = vault_root(store)
        if str(root) != request["vault"]:
            raise Conflict("笔记库配置已变化，请重新预览")
        target = note_target(root, str(Path(request["target"]).relative_to(root)))
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as opened:
            opened.write(request["content"])
    return dict(path=str(target))
