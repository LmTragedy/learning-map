"""Render model-authored lesson markup without granting browser capabilities."""

from html import escape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote

LESSON_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; "
    "img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; "
    # Popups only, so source links can open the original page in a new tab; scripts stay off.
    "sandbox allow-popups allow-popups-to-escape-sandbox"
)
_TAGS = frozenset(
    "article section header footer h1 h2 h3 h4 p div span strong em b i "
    "ul ol li pre code blockquote table thead tbody tr th td caption "
    "details summary br hr sub sup dl dt dd".split()
)
_VOID = {"br", "hr"}
_DROP_CONTENT = {"script", "style", "iframe", "object", "svg", "math", "template"}


class LessonMarkup(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.stack, self.blocked = [], [], []
        self.text_length = 0

    def handle_starttag(self, tag, attrs):
        if self.blocked or tag in _DROP_CONTENT:
            if tag not in {"img", "input", "meta", "link", "br", "hr", "source", "embed"}:
                self.blocked.append(tag)
            return
        if tag in _TAGS:
            self.parts.append(f"<{tag}>")
            if tag not in _VOID:
                self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.blocked:
            if tag in self.blocked:
                self.blocked = self.blocked[: self.blocked.index(tag)]
            return
        if tag in self.stack:
            while self.stack:
                current = self.stack.pop()
                self.parts.append(f"</{current}>")
                if current == tag:
                    break

    def handle_data(self, content):
        if not self.blocked:
            self.parts.append(escape(content))
            self.text_length += len(content.strip())

    def sanitized(self):
        return "".join(self.parts) + "".join(f"</{tag}>" for tag in reversed(self.stack))


def _citation(source):
    return f"<li>{escape(source['name'])} · 第 {source['page']} 页</li>"


def link_citations(html, course_id, sources, material_ids):
    """Turn the saved footer citations into links that open the original page in a new tab.

    Done when serving, so lessons saved earlier get links too; downloads keep plain text, because a
    relative link means nothing outside this app.
    """
    for source in sources:
        if source["material_id"] not in material_ids:
            continue
        url = f"/api/courses/{quote(course_id)}/materials/{quote(source['material_id'])}/file#page={int(source['page'])}"
        linked = (f'<li><a href="{escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">'
                  f"{escape(source['name'])} · 第 {source['page']} 页</a></li>")
        html = html.replace(_citation(source), linked, 1)
    return html


def _handoff(kind, label, text):
    text = text.strip()
    return f'<aside class="handoff is-{kind}"><p class="handoff-k">{label}</p><p>{escape(text)}</p></aside>' if text else ""


def render_lesson(draft, sources):
    parser = LessonMarkup()
    parser.feed(draft["html"])
    parser.close()
    if parser.text_length < 20:
        raise ValueError("小课没有足够的可阅读内容，未保存，请重新生成。")
    css = Path(__file__).with_name("lesson.css").read_text(encoding="utf-8")
    # Browsers accept sandbox only in HTTP headers; downloads still forbid all scripts/resources.
    meta_policy = LESSON_CSP.split("; sandbox", 1)[0]
    citations = "".join(_citation(source) for source in sources)
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<meta http-equiv="Content-Security-Policy" content="{escape(meta_policy, quote=True)}">'
        f"<title>{escape(draft['title'])}</title><style>{css}</style></head><body><main>"
        '<header><p class="eyebrow">LEARNING MAP · TEACH 小课</p>'
        f'<h1>{escape(draft["title"])}</h1><p class="goal">{escape(draft["goal"])}</p></header>'
        + _handoff("previous", "上节课回顾", draft.get("previous_recap", "")) +
        f'{parser.sanitized()}<section class="check"><h2>停一下，自己试试</h2>'
        f"<p>{escape(draft['check_question'])}</p><details><summary>想好后查看参考思路</summary>"
        f"<p>{escape(draft['check_answer'])}</p></details></section>"
        f"<section><h2>随手复习</h2><p>{escape(draft['recap'])}</p></section>"
        + _handoff("next", "下节课预告", draft.get("next_preview", "")) +
        "<footer><h2>回到资料核对</h2><ul>" + citations + "</ul>"
        "<p>以上是基于资料的 AI 教学解释；原文、公式和图表请回到节点来源核对。"
        "有疑问可回到学习对话继续提问。阅读和自测不代表已通过节点验收。</p>"
        "<p>Teaching method: Matt Pocock · Teach (MIT)</p></footer></main></body></html>"
    )
