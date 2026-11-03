import hashlib

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas

from .domain import make_node
from .store import identity

SAMPLE = [
    (
        "关系与键",
        "理解关系、主键与外键，并判断它们在具体数据中的作用。",
        [
            "A relation stores tuples (rows) with named attributes (columns).",
            "A primary key uniquely identifies a row and cannot be null.",
            "A foreign key references a candidate key in another relation.",
            "Example: Enrollment(student_id, course_id) links students and courses.",
        ],
    ),
    (
        "事务与 ACID",
        "通过转账例子解释原子性、一致性、隔离性与持久性。",
        [
            "A transaction groups database changes into one logical unit.",
            "Atomicity: all changes commit, or none take effect.",
            "Consistency: application and database invariants remain satisfied.",
            "Isolation: concurrent transactions behave according to an isolation level.",
            "Durability: committed changes survive a crash.",
            "Transfer: debit A and credit B together; preserve A + B = constant.",
        ],
    ),
    (
        "提交与回滚",
        "根据转账中途失败的案例，判断何时提交、回滚及它们的作用。",
        [
            "COMMIT makes a successful transaction durable.",
            "ROLLBACK discards the current transaction's uncommitted changes.",
            "If debit succeeds but credit fails, rollback prevents partial transfer.",
            "ROLLBACK is not a general undo of an already committed transaction.",
        ],
    ),
    (
        "隔离与并发",
        "判断丢失更新的原因，并解释一种防止它的方法。",
        [
            "Two transactions can read the same balance and overwrite each other.",
            "A suitable lock or serializable transaction can prevent a lost update.",
            "Different isolation levels provide different guarantees and costs.",
        ],
    ),
]


def create_sample(store):
    course = store.create("数据库基础 · 示例课程 · " + identity()[:5])
    material_id = identity()
    directory = store.root / "courses" / course["id"] / "materials" / material_id
    directory.mkdir(parents=True)
    original = directory / "original.pdf"
    canvas = Canvas(str(original), pagesize=A4)
    pages = []
    for number, (_, _, lines) in enumerate(SAMPLE, 1):
        canvas.setFont("Helvetica-Bold", 18)
        canvas.drawString(48, 780, f"Database foundations - unit {number}")
        canvas.setFont("Helvetica", 12)
        for index, line in enumerate(lines):
            canvas.drawString(48, 730 - index * 28, line)
        canvas.showPage()
        pages.append(
            dict(
                number=number,
                text="\n".join(lines),
                method="人工编写的示例材料",
                uncertain=False,
                warnings=["示例内容与节点由人工编写，不是AI生成或真实课程进度"],
            )
        )
    canvas.save()
    with store.edit(course["id"]) as (current, connection):
        current["sample"] = True
        current["materials"].append(
            dict(
                id=material_id,
                name="database-sample.pdf",
                week="示例 1–4",
                kind="pdf",
                sha256=hashlib.sha256(original.read_bytes()).hexdigest(),
                pages=pages,
                warnings=["合成示例材料，所有节点初始未学习；不代表真实学习进度"],
            )
        )
        _sample_nodes(current, material_id)
        store.snapshot(current, "示例课程初始状态", connection)
    return store.course(course["id"])


def _sample_nodes(course, material_id):
    for number, (title, summary, _) in enumerate(SAMPLE, 1):
        node = make_node(
            dict(
                title=title,
                summary=summary,
                week=f"示例第 {number} 周",
                sources=[dict(material_id=material_id, page=number, quote="")],
                uncertain=False,
            )
        )
        if course["nodes"]:
            previous = course["nodes"][-1]["id"]
            node["prerequisites"] = [previous]
            course["edges"].append(
                dict(id=identity(), source=previous, target=node["id"], relation="示例前置", uncertain=False)
            )
        node["question"] = dict(
            prompt=f"用自己的话解释「{title}」，并给一个能检验你理解的具体例子。", kind="解释", rubric=summary
        )
        course["nodes"].append(node)
