"""Typeset LaTeX in saved lesson pages as native MathML.

Lesson pages run with scripts, fonts and network access disabled, so a client-side renderer such as
KaTeX cannot run inside them. MathML is drawn by the browser itself and needs none of those.
Conversion happens when a page is served, so lessons saved before this existed are typeset too,
while the stored record stays exactly as generated.
"""

import re
from html import escape, unescape

from latex2mathml.converter import convert

_TAG = re.compile(r"(<[^>]*>)")
# Text inside these elements is shown as written: code samples, page metadata, existing formulas.
_VERBATIM = {"pre", "code", "style", "script", "title", "math", "textarea"}
_MATH = re.compile(
    r"\\\[(?P<block>.+?)\\\]"
    r"|\$\$(?P<dblock>.+?)\$\$"
    r"|\\\((?P<inline>.+?)\\\)"
    # $x$ only when the dollars hug the formula, so prices like "$5 and $10" stay text.
    r"|(?<![\\$\w])\$(?P<dinline>[^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![\w$])",
    re.S,
)
MATH_CSS = (
    "<style>math { font-family: 'Cambria Math', 'STIX Two Math', 'Latin Modern Math', math; font-size: 1.08em; }"
    " math[display=block] { display: block math; margin: .9em 0; overflow-x: auto; overflow-y: hidden; }</style>"
)


def _formula(match):
    source = next(value for value in match.groupdict().values() if value is not None)
    display = "block" if match["block"] is not None or match["dblock"] is not None else "inline"
    try:
        return convert(source.strip(), display=display)
    except Exception:  # noqa: BLE001 - a formula the converter cannot read stays readable as source text.
        return None


def _typeset_text(text):
    plain = unescape(text)
    parts, last, changed = [], 0, False
    for match in _MATH.finditer(plain):
        mathml = _formula(match)
        if mathml is None:
            continue
        parts += [escape(plain[last:match.start()], quote=False), mathml]
        last, changed = match.end(), True
    if not changed:
        return text, False
    parts.append(escape(plain[last:], quote=False))
    return "".join(parts), True


def typeset_math(html):
    """Replace \\(…\\), \\[…\\], $…$ and $$…$$ in a lesson page's text with MathML."""
    tokens, open_verbatim, found = _TAG.split(html), [], False
    for index, token in enumerate(tokens):
        if index % 2:
            name = re.match(r"</?\s*([a-zA-Z0-9]+)", token)
            tag = name[1].lower() if name else ""
            if tag in _VERBATIM and not token.endswith("/>"):
                if token.startswith("</"):
                    if tag in open_verbatim:
                        del open_verbatim[len(open_verbatim) - 1 - open_verbatim[::-1].index(tag):]
                else:
                    open_verbatim.append(tag)
        elif token and not open_verbatim and ("\\" in token or "$" in token):
            tokens[index], changed = _typeset_text(token)
            found = found or changed
    result = "".join(tokens)
    if found and "</head>" in result:
        result = result.replace("</head>", MATH_CSS + "</head>", 1)
    return result
