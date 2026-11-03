from backend.lesson_coverage import uncovered_pieces


def _node(html, pieces):
    return {"lessons": [{"html": html, "recap": ""}], "pieces": [{"title": title} for title in pieces]}


def test_lists_pieces_no_lesson_mentions():
    node = _node("<h3>完备性（completeness）</h3><p>任意两个选项都能比较。</p>",
                 ["完备性", "传递性", "理性偏好与理性主体"])
    assert uncovered_pieces(node) == ["传递性", "理性偏好与理性主体"]


def test_compound_title_needs_every_part():
    assert uncovered_pieces(_node("<p>理性偏好……理性 主体</p>", ["理性偏好与理性主体"])) == []
    assert uncovered_pieces(_node("<p>理性偏好</p>", ["理性偏好与理性主体"])) == ["理性偏好与理性主体"]


def test_no_lessons_or_pieces_means_no_gaps():
    assert uncovered_pieces({"lessons": [], "pieces": [{"title": "完备性"}]}) == []
    assert uncovered_pieces(_node("<p>x</p>", [])) == []
