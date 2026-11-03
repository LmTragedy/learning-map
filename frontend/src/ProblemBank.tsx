import { useState } from "react";
import { BookCheck, ClipboardList, FileText, Pencil, Plus, Sparkles, Trash2, Upload, Wand2, X } from "lucide-react";
import { api, problemFileUrl } from "./api";
import { TaskCards } from "./aiTasks";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import type { Course, Problem, ProblemSet } from "./types";
import "./problemBank.css";

type Run = <T,>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
type Mode = { kind: "view" } | { kind: "import" } | { kind: "generate" } | { kind: "edit"; draft: Draft };
type Draft = { revision: number; title: string; instructions: string; problems: Problem[] };

/**
 * 真题题库: the learner's real problem sets are the standard. Problems can be practised on a node
 * directly, and the AI matches their format and difficulty for node questions and unit sets.
 */
export function ProblemBank({ course, busy, aiEnabled, run, onRefresh, onPractise }: {
  course: Course; busy: boolean; aiEnabled: boolean; run: Run;
  onRefresh: (course: Course) => void;
  /** Opens the node's practice tab after its question was set. */
  onPractise: (nodeId: string) => void;
}) {
  const sets = course.problem_sets || [];
  const [selectedId, setSelectedId] = useState(sets[0]?.id || "");
  const [mode, setMode] = useState<Mode>(sets.length ? { kind: "view" } : { kind: "import" });
  const [error, setError] = useState("");
  const selected = sets.find((set) => set.id === selectedId) || sets[0];
  const nodeTitle = (id: string) => course.nodes.find((node) => node.id === id)?.title || "（已删除的知识点）";

  async function perform(key: string, action: () => Promise<Course>) {
    setError("");
    const updated = await run(key, async () => {
      try { return await action(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "题库操作失败"); throw failure; }
    });
    if (updated) onRefresh(updated);
    return updated;
  }
  async function practise(problemSet: ProblemSet, problem: Problem, nodeId: string) {
    const updated = await perform("problem-practise", () => api.practiseProblem(course.id, nodeId, problemSet.id, problem.id));
    if (updated) onPractise(nodeId);
  }

  return <div className="modal-body problem-bank">
    <div className="problem-toolbar">
      <div>
        <p className="text-sm text-foreground">{sets.filter((set) => set.origin === "real").length} 份真题 · {sets.filter((set) => set.origin === "ai").length} 份 AI 单元题</p>
        <p className="problem-muted">导入的真题是出题基准：AI 生成验收题和单元题时，会对齐真题的题型、难度和格式。也可以直接用真题练习。</p>
      </div>
      <div className="problem-actions">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setMode({ kind: "import" })}><Upload />导入真题</Button>
        <Button size="sm" disabled={busy || !aiEnabled || !sets.some((set) => set.origin === "real") || !course.materials.length}
          title={!aiEnabled ? "需先在设置中开启 AI" : !sets.some((set) => set.origin === "real") ? "先导入至少一份真题" : !course.materials.length ? "先导入课程 PDF" : "按所选 PDF 内容和真题标准出一套题"}
          onClick={() => setMode({ kind: "generate" })}><Wand2 />按标准出单元题</Button>
      </div>
    </div>
    {error && <p className="problem-error" role="alert">{error}</p>}
    <TaskCards kind="problem_unit" target="course" />
    <div className="problem-layout">
      <nav className="problem-sets" aria-label="题库列表">
        {sets.length ? sets.map((set) => <button key={set.id} className={`problem-set-card ${selected?.id === set.id && mode.kind !== "import" && mode.kind !== "generate" ? "is-selected" : ""}`}
          onClick={() => { setSelectedId(set.id); setMode({ kind: "view" }); }} disabled={mode.kind === "edit"}>
          <strong>{set.title}</strong>
          <span>{set.origin === "real" ? "真题" : "AI 按真题出题"} · {set.problems.length} 道</span>
        </button>) : <p className="problem-muted">还没有题目。</p>}
      </nav>
      <section className="problem-main">
        {mode.kind === "import" ? <ImportForm busy={busy} onCancel={sets.length ? () => setMode({ kind: "view" }) : undefined}
          onSubmit={async (value) => {
            const updated = await perform("problem-import", () => api.createProblemSet(course.id, value));
            if (updated) { setSelectedId(updated.problem_sets?.at(-1)?.id || ""); setMode({ kind: "view" }); }
          }} />
        : mode.kind === "generate" ? <GenerateForm course={course} busy={busy} onCancel={() => setMode({ kind: "view" })}
          onSubmit={async (value) => {
            const updated = await perform("problem-unit", () => api.generateUnit(course.id, value));
            if (updated) { setSelectedId(updated.problem_sets?.at(-1)?.id || ""); setMode({ kind: "view" }); }
          }} />
        : mode.kind === "edit" && selected ? <EditSet course={course} draft={mode.draft} busy={busy}
          onChange={(draft) => setMode({ kind: "edit", draft })} onCancel={() => setMode({ kind: "view" })}
          onSave={async () => {
            const { draft } = mode;
            const updated = await perform("problem-save", () => api.updateProblemSet(course.id, selected.id, {
              revision: draft.revision, title: draft.title, instructions: draft.instructions,
              problems: draft.problems.map(({ id, number, text, answer, node_ids }) => ({ id, number, text, answer, node_ids })),
            }));
            if (updated) setMode({ kind: "view" });
          }} />
        : selected ? <SetView course={course} set={selected} busy={busy} nodeTitle={nodeTitle}
          onEdit={() => setMode({ kind: "edit", draft: { revision: course.revision, title: selected.title, instructions: selected.instructions || "", problems: selected.problems.map((problem) => ({ ...problem })) } })}
          onDelete={() => { if (window.confirm(`删除「${selected.title}」？删除前会自动保存课程版本，可在版本历史恢复。`)) void perform("problem-delete", () => api.deleteProblemSet(course.id, selected.id)).then((updated) => updated && setSelectedId(updated.problem_sets?.[0]?.id || "")); }}
          onPractise={(problem, nodeId) => void practise(selected, problem, nodeId)} />
        : null}
      </section>
    </div>
  </div>;
}

function ImportForm({ busy, onSubmit, onCancel }: {
  busy: boolean; onCancel?: () => void;
  onSubmit: (value: { title: string; text: string; answer_text: string; files: File[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  return <form className="problem-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ title, text, answer_text: answer, files }); }}>
    <h3><Upload size={16} />导入真题</h3>
    <p className="problem-muted">上传 problem set / 往年试卷的 PDF、图片或文本，或直接粘贴题目。会按 “1.” “Problem 1” “第1题” 等编号自动切题，单独一行 <code>---</code> 可以手动分隔。导入后可以逐题修改、关联知识点。</p>
    <label className="field-label">名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如 Problem Set 3 / 2024 期中" maxLength={160} /></label>
    <label className="upload-inline problem-file"><FileText size={14} />{files.length ? files.map((file) => file.name).join("、") : "选择 PDF / 图片 / TXT（可多选）"}
      <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" onChange={(event) => setFiles(Array.from(event.target.files || []))} /></label>
    <label className="field-label">或粘贴题目文字<textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder={"1. ……\n2. ……"} /></label>
    <label className="field-label">参考答案（可选，按同样编号对应到题目）<textarea rows={4} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={"1. ……\n2. ……"} /></label>
    <div className="problem-actions">
      {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>}
      <Button type="submit" size="sm" disabled={busy || (!text.trim() && !files.length)}><Upload />导入并切题</Button>
    </div>
  </form>;
}

function GenerateForm({ course, busy, onSubmit, onCancel }: {
  course: Course; busy: boolean; onCancel: () => void;
  onSubmit: (value: { material_ids: string[]; problem_set_ids: string[]; count: number; focus: string }) => Promise<void>;
}) {
  const realSets = (course.problem_sets || []).filter((set) => set.origin === "real");
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [setIds, setSetIds] = useState<string[]>(realSets.map((set) => set.id));
  const [count, setCount] = useState(5);
  const [focus, setFocus] = useState("");
  const toggle = (ids: string[], id: string, on: boolean) => on ? [...ids, id] : ids.filter((item) => item !== id);
  return <form className="problem-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ material_ids: materialIds, problem_set_ids: setIds, count, focus }); }}>
    <h3><Wand2 size={16} />按 PDF 和真题标准出单元题</h3>
    <p className="problem-muted">内容取自所选课程 PDF（这一单元讲了什么），题型、难度和格式对齐所选真题（老师怎么出题）。生成的题标为 AI 出题，可编辑后再练。所选 PDF 和真题会发送给 AI。</p>
    <fieldset><legend>本单元的课程材料</legend>
      <div className="problem-checks">{course.materials.map((material) => <label key={material.id}>
        <input type="checkbox" checked={materialIds.includes(material.id)} onChange={(event) => setMaterialIds((ids) => toggle(ids, material.id, event.target.checked))} />
        {material.name}{material.week && <span className="problem-muted"> · {material.week}</span>}
      </label>)}</div>
    </fieldset>
    <fieldset><legend>参照的真题</legend>
      <div className="problem-checks">{realSets.map((set) => <label key={set.id}>
        <input type="checkbox" checked={setIds.includes(set.id)} onChange={(event) => setSetIds((ids) => toggle(ids, set.id, event.target.checked))} />
        {set.title} <span className="problem-muted">· {set.problems.length} 道</span>
      </label>)}</div>
    </fieldset>
    <div className="problem-row">
      <label className="field-label">题目数量<input type="number" min={1} max={12} value={count} onChange={(event) => setCount(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} /></label>
      <label className="field-label problem-grow">补充要求（可选）<input value={focus} onChange={(event) => setFocus(event.target.value)} maxLength={1000} placeholder="例如：多出计算题，带小问" /></label>
    </div>
    <div className="problem-actions">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
      <Button type="submit" size="sm" disabled={busy || !materialIds.length || !setIds.length}><Sparkles />开始出题</Button>
    </div>
  </form>;
}

function SetView({ course, set, busy, nodeTitle, onEdit, onDelete, onPractise }: {
  course: Course; set: ProblemSet; busy: boolean; nodeTitle: (id: string) => string;
  onEdit: () => void; onDelete: () => void; onPractise: (problem: Problem, nodeId: string) => void;
}) {
  const materials = new Map(course.materials.map((material) => [material.id, material.name]));
  const benchmark = new Map((course.problem_sets || []).flatMap((item) => item.problems.map((problem) => [problem.id, `${item.title}${problem.number ? ` 第${problem.number}题` : ""}`] as const)));
  return <div className="problem-set-view">
    <div className="problem-set-head">
      <div>
        <h3><ClipboardList size={16} />{set.title} <Badge variant={set.origin === "real" ? "passed" : "new"}>{set.origin === "real" ? "真题" : "AI 出题"}</Badge></h3>
        {set.files.length > 0 && <p className="problem-muted">原文件：{set.files.map((file, index) => <span key={file.id}>{index > 0 && "、"}<a href={problemFileUrl(course.id, set.id, file.id)} target="_blank" rel="noreferrer">{file.name}</a></span>)}</p>}
        {set.basis && <p className="problem-muted">依据材料：{set.basis.material_ids.map((id) => materials.get(id) || "（已删除）").join("、")}</p>}
      </div>
      <div className="problem-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}><Pencil />编辑题目</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}><Trash2 />删除</Button>
      </div>
    </div>
    {set.instructions && <p className="problem-standard"><strong>总说明：</strong>{set.instructions}</p>}
    {set.standard && <p className="problem-standard"><strong>AI 归纳的出题标准：</strong>{set.standard}</p>}
    {set.problems.map((problem, index) => <article className="problem-item" key={problem.id}>
      <header><strong>第 {problem.number || index + 1} 题</strong>{problem.kind && <Badge variant="outline">{problem.kind}</Badge>}</header>
      <p className="problem-text">{problem.text}</p>
      {problem.answer && <details><summary>参考答案</summary><p className="problem-text">{problem.answer}</p></details>}
      {!!problem.sources?.length && <p className="problem-muted">依据：{problem.sources.map((source) => `${materials.get(source.material_id) || "材料"} 第 ${source.page} 页`).join("；")}</p>}
      {!!problem.benchmark_ids?.length && <p className="problem-muted">参照真题：{problem.benchmark_ids.map((id) => benchmark.get(id) || "（已删除）").join("；")}</p>}
      <footer>
        {problem.node_ids.length ? problem.node_ids.map((nodeId) => <Button key={nodeId} size="sm" variant="outline" disabled={busy || !course.nodes.some((node) => node.id === nodeId)}
          title="把这道题设为该知识点的验收题，并打开练习" onClick={() => onPractise(problem, nodeId)}><BookCheck />在「{nodeTitle(nodeId)}」练这道</Button>)
          : <span className="problem-muted">还没关联知识点。点「编辑题目」关联后就能练，AI 给这些知识点出题时也会优先参照它。</span>}
      </footer>
    </article>)}
  </div>;
}

function EditSet({ course, draft, busy, onChange, onSave, onCancel }: {
  course: Course; draft: Draft; busy: boolean;
  onChange: (draft: Draft) => void; onSave: () => Promise<void>; onCancel: () => void;
}) {
  const setProblem = (index: number, patch: Partial<Problem>) =>
    onChange({ ...draft, problems: draft.problems.map((problem, at) => at === index ? { ...problem, ...patch } : problem) });
  const stale = draft.revision !== course.revision;
  return <form className="problem-form" onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
    <label className="field-label">名称<input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} maxLength={160} /></label>
    <label className="field-label">总说明（可选，练习时附在每道题前）<textarea rows={2} value={draft.instructions} onChange={(event) => onChange({ ...draft, instructions: event.target.value })} maxLength={4000} /></label>
    {stale && <p className="problem-muted" role="status">课程在编辑期间有变化，保存可能被拒绝；先复制好修改，再取消并重新编辑。</p>}
    {draft.problems.map((problem, index) => <fieldset className="problem-edit" key={problem.id || index}>
      <div className="problem-row">
        <label className="field-label problem-number">题号<input value={problem.number} onChange={(event) => setProblem(index, { number: event.target.value })} maxLength={40} /></label>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...draft, problems: draft.problems.filter((_, at) => at !== index) })}><Trash2 />删除这题</Button>
        {index > 0 && <Button type="button" size="sm" variant="ghost" title="把这题并到上一题末尾（自动切错时用）"
          onClick={() => onChange({ ...draft, problems: draft.problems.flatMap((item, at) => at === index - 1 ? [{ ...item, text: `${item.text}\n\n${problem.text}`, answer: [item.answer, problem.answer].filter(Boolean).join("\n\n") }] : at === index ? [] : [item]) })}>并入上一题</Button>}
      </div>
      <label className="field-label">题目<textarea rows={5} value={problem.text} onChange={(event) => setProblem(index, { text: event.target.value })} /></label>
      <label className="field-label">参考答案<textarea rows={3} value={problem.answer} onChange={(event) => setProblem(index, { answer: event.target.value })} /></label>
      <div className="problem-nodes">
        <span className="problem-muted">关联知识点：</span>
        {problem.node_ids.map((nodeId) => <span className="problem-chip" key={nodeId}>{course.nodes.find((node) => node.id === nodeId)?.title || "（已删除）"}
          <button type="button" aria-label="取消关联" onClick={() => setProblem(index, { node_ids: problem.node_ids.filter((id) => id !== nodeId) })}><X size={12} /></button></span>)}
        <select aria-label="添加关联知识点" value="" onChange={(event) => event.target.value && setProblem(index, { node_ids: [...problem.node_ids, event.target.value] })}>
          <option value="">＋ 添加知识点</option>
          {course.nodes.filter((node) => !problem.node_ids.includes(node.id)).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
        </select>
      </div>
    </fieldset>)}
    <Button type="button" size="sm" variant="outline" onClick={() => onChange({ ...draft, problems: [...draft.problems, { id: "", number: String(draft.problems.length + 1), text: "", answer: "", node_ids: [] }] })}><Plus />添加一道题</Button>
    <div className="problem-actions problem-sticky">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
      <Button type="submit" size="sm" disabled={busy || !draft.title.trim() || draft.problems.some((problem) => !problem.text.trim())}>保存</Button>
    </div>
  </form>;
}
