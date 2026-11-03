"""Which real problems are close in content to a knowledge node.

Local and deterministic: TF-IDF over Chinese character bigrams and English words, cosine similarity.
It needs no model call, so every question can use it. A node is described by its title, summary
and the pages it cites; a problem by its text and answer. Screenshot-only problems without text
have nothing to compare and score zero.
"""

import math
import re
from collections import Counter

_WORD = re.compile(r"[a-z][a-z0-9]+|\d+")
_CJK = re.compile(r"[一-鿿]+")
_STOP = {
    "the", "and", "for", "are", "with", "that", "this", "from", "into", "its", "you", "your", "all", "any", "one",
    "show", "work", "give", "find", "let", "use", "using", "each", "what", "which", "when", "how", "why", "can",
    "will", "not", "has", "have", "been", "was", "were", "their", "them", "then", "than", "also", "both", "part",
    "problem", "question", "answer", "solution", "explain", "example", "points", "point",
}
_CJK_STOP = {"一个", "这个", "我们", "以及", "可以", "如果", "什么", "如何", "说明", "解释", "根据", "判断", "下列", "以下"}
SOURCE_CHARS = 1500
MAX_SOURCES = 3


def tokens(text):
    lowered = (text or "").lower()
    words = [word for word in _WORD.findall(lowered) if word not in _STOP]
    bigrams = [run[i:i + 2] for run in _CJK.findall(lowered) for i in range(len(run) - 1)]
    singles = [run for run in _CJK.findall(lowered) if len(run) == 1]
    return words + [gram for gram in bigrams if gram not in _CJK_STOP] + singles


def node_document(course, node):
    pages = {(material["id"], page["number"]): page["text"] for material in course["materials"] for page in material["pages"]}
    parts = [node["title"]] * 3 + [node.get("summary", "")] * 2
    for piece in node.get("pieces", []):
        parts.append(f"{piece.get('title', '')} {piece.get('detail', '')}")
    for source in node.get("sources", [])[:MAX_SOURCES]:
        parts.append(source.get("quote") or "")
        parts.append(pages.get((source["material_id"], source["page"]), "")[:SOURCE_CHARS])
    return " ".join(parts)


def problem_document(problem):
    return f"{problem.get('text', '')} {problem.get('answer', '')[:800]}"


def _vectors(documents):
    counts = [Counter(tokens(document)) for document in documents]
    frequency = Counter(term for count in counts for term in count)
    total = len(documents)
    vectors = []
    for count in counts:
        vector = {term: (1 + math.log(value)) * math.log((1 + total) / (1 + frequency[term])) for term, value in count.items()}
        norm = math.sqrt(sum(weight * weight for weight in vector.values())) or 1.0
        vectors.append({term: weight / norm for term, weight in vector.items()})
    return vectors


def similarities(course, node, problems):
    """Cosine similarity between the node and each problem, in the order given (0 when nothing to compare)."""
    if not problems:
        return []
    # IDF over every node and every problem, so words common to the whole course weigh little.
    documents = [problem_document(problem) for problem in problems]
    others = [node_document(course, other) for other in course["nodes"] if other["id"] != node["id"]]
    vectors = _vectors([node_document(course, node), *documents, *others])
    target = vectors[0]
    return [sum(weight * target.get(term, 0.0) for term, weight in vector.items()) for vector in vectors[1:1 + len(problems)]]
