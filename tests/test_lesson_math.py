from backend.lesson_html import render_lesson
from backend.lesson_math import MATH_CSS, typeset_math


def page(body, title="扩展式博弈"):
    return render_lesson(dict(title=title, goal="理解策略集合", html=body, check_question="q",
                              check_answer="a", recap="r"), [])


def test_latex_delimiters_become_mathml():
    html = typeset_math(page(r"<p>策略集合 \[ S_i=\prod_{h\in H:\rho(h)=i}\chi(h) \] 以及 \(S_i\) 和 $$a&lt;b$$ 与 $v_2$。</p>"))
    assert html.count('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">') == 2
    assert html.count('display="inline"') == 2
    assert r"\prod" not in html and "\\(" not in html
    assert "<mo>&#x0003C;</mo>" in html  # the escaped "<" is read as a comparison, not markup
    assert html.count(MATH_CSS) == 1


def test_code_title_and_prices_stay_as_written():
    html = typeset_math(page(r"<p>价格 $5 和 $10</p><pre><code>echo \(x\) $y$</code></pre>"))
    assert "<math" not in html and MATH_CSS not in html
    assert r"echo \(x\) $y$" in html


def test_heading_is_typeset_but_tab_title_is_not():
    html = typeset_math(page("<p>这一节用硬币例子说明玩家在每个决策点如何选择行动。</p>", title=r"策略 \(S_i\)"))
    assert r"<title>策略 \(S_i\)</title>" in html
    assert "<h1>策略 <math" in html


def test_unparsable_formula_stays_readable():
    html = typeset_math("<p>\\(\\frac{a\\) 然后 \\(b\\)</p>")
    assert "\\frac" in html or "<math" in html
    assert html.endswith("</p>")
