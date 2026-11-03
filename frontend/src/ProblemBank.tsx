import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  BookCheck, Check, ChevronLeft, ChevronRight, ClipboardList, Crop, Ellipsis, Eye, EyeOff, FileText, ImagePlus,
  Link2, Pencil, Play, Sparkles, Trash2, Upload, Wand2, X,
} from "lucide-react";
import { api, problemImageUrl, problemPageUrl } from "./api";
import { TaskCards } from "./aiTasks";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { problemRef, problemStatuses, STATUS_LABEL, type ProblemStatus } from "./problemStatus";
import type { Course, Problem, ProblemImage, ProblemSet } from "./types";
import "./problemBank.css";

type Run = <T,>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
type View = "nodes" | "set" | "import" | "generate";
type Filter = "all" | ProblemStatus;
type CropTarget = { problem: Problem; target: "images" | "answer_images" };
type CropValue = { file_id: string; page: number; box: number[]; target: "images" | "answer_images"; replace: boolean };
/** Everything a problem card can do, bound to the set it belongs to. */
type Actions = {
  change: (problem: Problem, change: Partial<Problem> | null) => Promise<Course | undefined>;
  addImages: (problem: Problem, files: File[], target: "images" | "answer_images") => Promise<Course | undefined>;
  openCrop: (problem: Problem, target: "images" | "answer_images") => void;
  practise: (problem: Problem, nodeId: string) => void;
};

const img = (cid: string, set: ProblemSet, image: ProblemImage) => problemImageUrl(cid, `${set.id}/${image.id}`);
const UNLINKED = "__unlinked__";

/** Whole set payload for the update route. */
function payload(course: Course, set: ProblemSet, problems: Problem[]) {
  return {
    revision: course.revision, title: set.title, instructions: set.instructions || "",
    problems: problems.map((problem) => ({
      id: problem.id, number: problem.number, text: problem.text, answer: problem.answer, node_ids: problem.node_ids,
      related_node_ids: problem.related_node_ids || [], key_points: problem.key_points || [],
      images: (problem.images || []).map((image) => image.id), answer_images: (problem.answer_images || []).map((image) => image.id),
    })),
  };
}

/** Knowledge nodes in learning-route order, so the bank reads like the map. */
function routeOrder(course: Course) {
  const ordered = course.route?.stages?.flatMap((stage) => stage.node_ids) || [];
  const seen = new Set(ordered);
  return [...ordered, ...course.nodes.map((node) => node.id).filter((id) => !seen.has(id))]
    .map((id) => course.nodes.find((node) => node.id === id)).filter((node) => node !== undefined);
}

/**
 * 真题题库: real problems belong to knowledge nodes. PDFs are cut into one HD screenshot per problem,
 * answers are matched by number, and AI links each problem to the node it tests. The default view is
 * by node, like the map; the by-paper view is for checking imports and fixing screenshots.
 */
export function ProblemBank({ course, busy, aiEnabled, run, onRefresh, onPractise, onOpenNode }: {
  course: Course; busy: boolean; aiEnabled: boolean; run: Run;
  onRefresh: (course: Course) => void;
  onPractise: (nodeId: string) => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const sets = course.problem_sets || [];
  const [selectedId, setSelectedId] = useState(sets[0]?.id || "");
  const [nodeFilter, setNodeFilter] = useState("");
  const [view, setView] = useState<View>(sets.length ? "nodes" : "import");
  const [error, setError] = useState("");
  const [cropping, setCropping] = useState<CropTarget & { setId: string }>();
  const selected = sets.find((set) => set.id === selectedId) || sets[0];
  const statuses = useMemo(() => problemStatuses(course), [course]);
  const realSets = sets.filter((set) => set.origin === "real");
  const unitSets = sets.filter((set) => set.origin === "ai");
  const canLink = aiEnabled && course.nodes.length > 0;

  async function perform(key: string, action: () => Promise<Course>) {
    setError("");
    const updated = await run(key, async () => {
      try { return await action(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "题库操作失败"); throw failure; }
    });
    if (updated) onRefresh(updated);
    return updated;
  }
  // Each call reads the latest course, so consecutive edits never send a stale revision.
  const actionsFor = (set: ProblemSet): Actions => ({
    change: (problem, change) => perform("problem-save", () => api.updateProblemSet(course.id, set.id, payload(course, set,
      change ? set.problems.map((item) => item.id === problem.id ? { ...item, ...change } : item) : set.problems.filter((item) => item.id !== problem.id)))),
    addImages: (problem, files, target) => perform("problem-save", () => api.addProblemImages(course.id, set.id, problem.id, files, target)),
    openCrop: (problem, target) => setCropping({ setId: set.id, problem, target }),
    practise: (problem, nodeId) => void perform("problem-practise", () => api.practiseProblem(course.id, nodeId, set.id, problem.id)).then((updated) => updated && onPractise(nodeId)),
  });
  const link = (set: ProblemSet) => perform("problem-link", () => api.linkProblems(course.id, set.id));
  const openSet = (id: string) => { setSelectedId(id); setView("set"); };
  const cropSet = cropping && sets.find((set) => set.id === cropping.setId);

  const unitBlocked = !aiEnabled ? "需先在设置中开启 AI" : !realSets.length ? "先导入至少一份真题" : !course.materials.length ? "先导入课程 PDF" : "";
  const summary = new Map<string, { total: number; passed: number }>();
  let unlinked = 0;
  for (const set of sets) for (const problem of set.problems) {
    if (!problem.node_ids.length) unlinked += 1;
    for (const nodeId of problem.node_ids) {
      const entry = summary.get(nodeId) || { total: 0, passed: 0 };
      entry.total += 1;
      if (statuses.get(problemRef(set, problem)) === "passed") entry.passed += 1;
      summary.set(nodeId, entry);
    }
  }
  const nodesWithProblems = routeOrder(course).filter((node) => summary.has(node.id));
  return <div className="pb">
    <aside className="pb-rail" aria-label="题库">
      <Button className="pb-rail-main" size="sm" onClick={() => setView("import")} disabled={busy}><Upload />导入真题</Button>
      {sets.length > 0 && <div className="pb-seg" role="tablist" aria-label="浏览方式">
        <button role="tab" aria-selected={view !== "set"} className={view !== "set" ? "is-on" : ""} onClick={() => setView("nodes")}>按知识点</button>
        <button role="tab" aria-selected={view === "set"} className={view === "set" ? "is-on" : ""} onClick={() => openSet(selected?.id || "")}>按试卷</button>
      </div>}
      {view === "set" ? <>
        <SetGroup title="真题" sets={realSets} empty="还没有导入真题" selectedId={selected?.id} statuses={statuses} onOpen={openSet} />
        <SetGroup title="AI 单元题" sets={unitSets} empty="按真题标准生成的练习会放在这里" selectedId={selected?.id} statuses={statuses} onOpen={openSet} />
      </> : sets.length > 0 && <div className="pb-group">
        <h3>知识点<span>{nodesWithProblems.length}</span></h3>
        <button className={`pb-set ${view === "nodes" && !nodeFilter ? "is-on" : ""}`} onClick={() => { setNodeFilter(""); setView("nodes"); }}>
          <span className="pb-set-title">全部知识点</span><span className="pb-set-meta">{sets.reduce((total, set) => total + set.problems.length, 0)} 道题</span>
        </button>
        {nodesWithProblems.map((node) => { const entry = summary.get(node.id)!; return <button key={node.id} className={`pb-set ${view === "nodes" && nodeFilter === node.id ? "is-on" : ""}`} onClick={() => { setNodeFilter(node.id); setView("nodes"); }}>
          <span className="pb-set-title"><span className={`pb-dot is-${node.status}`} aria-hidden />{node.title}</span>
          <span className="pb-set-meta">{entry.total} 道 · 通过 {entry.passed}</span>
          <span className="pb-bar" aria-hidden><span style={{ width: `${(entry.passed / entry.total) * 100}%` }} /></span>
        </button>; })}
        {unlinked > 0 && <button className={`pb-set ${view === "nodes" && nodeFilter === UNLINKED ? "is-on" : ""}`} onClick={() => { setNodeFilter(UNLINKED); setView("nodes"); }}>
          <span className="pb-set-title pb-warn">未关联知识点</span><span className="pb-set-meta">{unlinked} 道</span>
        </button>}
      </div>}
      <div className="pb-rail-foot">
        <Button size="sm" variant="outline" className="w-full" disabled={busy || !!unitBlocked} onClick={() => setView("generate")}><Wand2 />按标准出单元题</Button>
        {unitBlocked && <p className="pb-hint">{unitBlocked}</p>}
      </div>
    </aside>
    <section className="pb-main">
      {error && <div className="pb-error" role="alert"><span>{error}</span><button aria-label="关闭" onClick={() => setError("")}><X size={14} /></button></div>}
      <TaskCards kind={["problem_unit", "problem_link"]} />
      {view === "import" ? <ImportView busy={busy} canLink={canLink} hasNodes={course.nodes.length > 0} onCancel={sets.length ? () => setView("nodes") : undefined}
        onSubmit={async (value) => {
          const updated = await perform("problem-import", () => api.createProblemSet(course.id, value));
          const created = updated?.problem_sets?.at(-1);
          if (!created) return;
          openSet(created.id);
          // Problems belong to knowledge nodes: let AI place them right away; the learner can correct any link.
          if (canLink) await perform("problem-link", () => api.linkProblems(course.id, created.id));
        }} />
      : view === "generate" ? <GenerateView course={course} busy={busy} preselected={selected?.origin === "real" ? selected.id : ""} onCancel={() => setView("nodes")}
        onSubmit={async (value) => {
          const updated = await perform("problem-unit", () => api.generateUnit(course.id, value));
          if (updated) openSet(updated.problem_sets?.at(-1)?.id || "");
        }} />
      : view === "nodes" ? <NodesView course={course} sets={sets} statuses={statuses} busy={busy} filter={nodeFilter} actionsFor={actionsFor}
        canLink={canLink} onLinkAll={async () => { for (const set of sets.filter((item) => item.problems.some((problem) => !problem.node_ids.length))) await link(set); }}
        onOpenNode={onOpenNode} />
      : selected ? <SetView key={selected.id} course={course} set={selected} busy={busy} statuses={statuses} actions={actionsFor(selected)}
        rename={(title, instructions) => perform("problem-save", () => api.updateProblemSet(course.id, selected.id, { ...payload(course, selected, selected.problems), title, instructions }))}
        remove={() => { if (window.confirm(`删除「${selected.title}」？删除前会自动保存课程版本，可在版本历史恢复。`)) void perform("problem-delete", () => api.deleteProblemSet(course.id, selected.id)).then((updated) => { if (updated) setSelectedId(updated.problem_sets?.[0]?.id || ""); if (updated && !updated.problem_sets?.length) setView("import"); }); }}
        link={canLink ? () => void link(selected) : undefined}
        generate={() => setView("generate")} unitBlocked={unitBlocked} />
      : null}
    </section>
    {cropping && cropSet && <CropDialog course={course} set={cropSet} files={cropSet.files.filter((file) => file.kind === "pdf")} target={cropping} busy={busy}
      onClose={() => setCropping(undefined)}
      onCrop={async (value: CropValue) => { if (await perform("problem-save", () => api.cropProblem(course.id, cropSet.id, cropping.problem.id, value))) setCropping(undefined); }} />}
  </div>;
}

function NodesView({ course, sets, statuses, busy, filter, actionsFor, canLink, onLinkAll, onOpenNode }: {
  course: Course; sets: ProblemSet[]; statuses: Map<string, ProblemStatus>; busy: boolean; filter: string;
  actionsFor: (set: ProblemSet) => Actions; canLink: boolean; onLinkAll: () => void; onOpenNode: (nodeId: string) => void;
}) {
  const items = sets.flatMap((set) => set.problems.map((problem) => ({ set, problem, status: statuses.get(problemRef(set, problem)) || "new" as ProblemStatus })));
  const unlinked = items.filter(({ problem }) => !problem.node_ids.length);
  const groups = routeOrder(course).map((node) => ({ node, items: items.filter(({ problem }) => problem.node_ids.includes(node.id)) }))
    .filter((group) => group.items.length && (!filter || filter === group.node.id));
  const passed = items.filter((item) => item.status === "passed").length;
  return <div className="pb-set-view">
    <header className="pb-head">
      <div>
        <p className="pb-eyebrow">真题跟着知识点走：练通过就算这个知识点的验收</p>
        <h2>按知识点练真题</h2>
        <div className="pb-progress"><span className="pb-bar pb-bar-lg" aria-hidden><span style={{ width: `${items.length ? (passed / items.length) * 100 : 0}%` }} /></span><span>{passed}/{items.length} 道通过</span></div>
      </div>
    </header>
    {unlinked.length > 0 && (!filter || filter === UNLINKED) && <div className="pb-note pb-note-warn"><Link2 size={14} /><span><b>{unlinked.length} 道题还没挂到知识点上</b>
      {!course.nodes.length ? "先生成知识地图，再把真题关联到知识点。" : canLink ? "让 AI 按题目内容挂到对应知识点，或在题目上手动选择。" : "在题目上手动选择知识点；开启 AI 后可以自动关联。"}</span>
      {canLink && <Button size="sm" variant="outline" disabled={busy} onClick={onLinkAll}><Sparkles />AI 关联</Button>}</div>}
    {groups.map(({ node, items: nodeItems }) => {
      const done = nodeItems.filter((item) => item.status === "passed").length;
      const next = nodeItems.find((item) => item.status !== "passed");
      return <section key={node.id} className="pb-node">
        <header className="pb-node-head">
          <span className={`pb-dot is-${node.status}`} aria-hidden />
          <button className="pb-node-title" onClick={() => onOpenNode(node.id)} title="在地图中打开这个知识点">{node.title}</button>
          <span className="pb-hint">{done}/{nodeItems.length} 通过{node.verification !== "none" && node.status === "passed" ? " · 知识点已通过" : ""}</span>
          <div className="pb-actions">
            {next && <Button size="sm" onClick={() => actionsFor(next.set).practise(next.problem, node.id)} disabled={busy}><Play />{done ? "继续练" : "开始练"}</Button>}
          </div>
        </header>
        <div className="pb-list">{nodeItems.map(({ set, problem, status }) =>
          <ProblemCard key={`${node.id}:${problem.id}`} course={course} set={set} problem={problem} status={status} busy={busy} showSource
            canCrop={set.files.some((file) => file.kind === "pdf")} actions={actionsFor(set)} practiseNode={node.id} />)}</div>
      </section>;
    })}
    {(!filter || filter === UNLINKED) && unlinked.length > 0 && <section className="pb-node">
      <header className="pb-node-head"><span className="pb-dot" aria-hidden /><span className="pb-node-title pb-warn">未关联知识点</span><span className="pb-hint">{unlinked.length} 道</span></header>
      <div className="pb-list">{unlinked.map(({ set, problem, status }) =>
        <ProblemCard key={problem.id} course={course} set={set} problem={problem} status={status} busy={busy} showSource
          canCrop={set.files.some((file) => file.kind === "pdf")} actions={actionsFor(set)} />)}</div>
    </section>}
  </div>;
}

function SetGroup({ title, sets, empty, selectedId, statuses, onOpen }: {
  title: string; sets: ProblemSet[]; empty: string; selectedId?: string; statuses: Map<string, ProblemStatus>; onOpen: (id: string) => void;
}) {
  return <div className="pb-group">
    <h3>{title}<span>{sets.length}</span></h3>
    {sets.length ? sets.map((set) => {
      const passed = set.problems.filter((problem) => statuses.get(problemRef(set, problem)) === "passed").length;
      return <button key={set.id} className={`pb-set ${selectedId === set.id ? "is-on" : ""}`} onClick={() => onOpen(set.id)} aria-current={selectedId === set.id}>
        <span className="pb-set-title">{set.title}</span>
        <span className="pb-set-meta">{set.problems.length} 道 · 通过 {passed}</span>
        <span className="pb-bar" aria-hidden><span style={{ width: `${set.problems.length ? (passed / set.problems.length) * 100 : 0}%` }} /></span>
      </button>;
    }) : <p className="pb-hint">{empty}</p>}
  </div>;
}

// ---------------- import ----------------

function Dropzone({ label, hint, files, accept, onFiles, icon }: {
  label: string; hint: string; files: File[]; accept: string; onFiles: (files: File[]) => void; icon: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const drop = (event: DragEvent) => { event.preventDefault(); setOver(false); onFiles([...files, ...Array.from(event.dataTransfer.files)]); };
  return <div className={`pb-drop ${over ? "is-over" : ""} ${files.length ? "has-files" : ""}`}
    onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
    <button type="button" className="pb-drop-hit" onClick={() => input.current?.click()}>
      <span className="pb-drop-icon">{icon}</span>
      <strong>{label}</strong>
      <span>{hint}</span>
    </button>
    <input ref={input} type="file" multiple accept={accept} hidden onChange={(event) => { onFiles([...files, ...Array.from(event.target.files || [])]); event.target.value = ""; }} />
    {files.length > 0 && <ul className="pb-files">{files.map((file, index) => <li key={`${file.name}-${index}`}>
      <FileText size={14} /><span>{file.name}</span><small>{file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small>
      <button type="button" aria-label={`移除 ${file.name}`} onClick={() => onFiles(files.filter((_, at) => at !== index))}><X size={13} /></button>
    </li>)}</ul>}
  </div>;
}

function pastedImages(event: ClipboardEvent) {
  return Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
    .map((file, index) => new File([file], file.name && file.name !== "image.png" ? file.name : `粘贴截图-${Date.now()}-${index + 1}.png`, { type: file.type }));
}

function ImportView({ busy, canLink, hasNodes, onSubmit, onCancel }: {
  busy: boolean; canLink: boolean; hasNodes: boolean; onCancel?: () => void;
  onSubmit: (value: { title: string; text: string; answer_text: string; files: File[]; answer_files: File[]; screenshot_mode: "each" | "one" }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [answers, setAnswers] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [together, setTogether] = useState(false);
  const images = files.filter((file) => file.type.startsWith("image/")).length;
  const shownTitle = title || (files[0] ? files[0].name.replace(/\.[^.]+$/, "") : "");
  return <form className="pb-import" onSubmit={(event) => { event.preventDefault(); void onSubmit({ title: shownTitle, text, answer_text: answerText, files, answer_files: answers, screenshot_mode: together ? "one" : "each" }); }}
    onPaste={(event) => { const pasted = pastedImages(event); if (pasted.length) { event.preventDefault(); setFiles((current) => [...current, ...pasted]); } }}>
    <header className="pb-head">
      <div><h2>导入真题</h2><p>把题目 PDF 和答案 PDF 一起放进来。每道题会按题号切成高清截图，答案按同一题号配上；公式和图都保留原样。</p></div>
      {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>}
    </header>
    <div className="pb-drops">
      <Dropzone label="题目 PDF" hint="拖到这里或点击选择 · 也可以 Ctrl+V 粘贴截图" files={files} accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" onFiles={setFiles} icon={<ClipboardList size={20} />} />
      <Dropzone label="答案 PDF（可选）" hint="solutions / 参考答案，按题号自动配对" files={answers} accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md" onFiles={setAnswers} icon={<BookCheck size={20} />} />
    </div>
    {images > 1 && <label className="pb-check"><input type="checkbox" checked={together} onChange={(event) => setTogether(event.target.checked)} />这 {images} 张截图是同一道题</label>}
    <label className="pb-field">名称<input value={shownTitle} onChange={(event) => setTitle(event.target.value)} placeholder="例如 Problem Set 3 / 2024 期中" maxLength={160} /></label>
    <details className="pb-more">
      <summary>没有 PDF？直接粘贴题目和答案文字</summary>
      <div className="pb-two">
        <label className="pb-field">题目<textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} placeholder={"1. ……\n2. ……"} /></label>
        <label className="pb-field">答案<textarea rows={6} value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder={"1. ……\n2. ……"} /></label>
      </div>
    </details>
    <footer className="pb-foot">
      <span className="pb-hint">{canLink ? "导入后 AI 会把每道题挂到对应的知识点上，可以再手动调整。" : hasNodes ? "导入后在题目上选择知识点（开启 AI 可自动关联）。" : "还没有知识地图：导入后先生成地图，再把题目关联到知识点。"}
        切得不准的题可以在原页上重新框选。</span>
      <Button type="submit" disabled={busy || (!files.length && !text.trim())}><Upload />导入并切题</Button>
    </footer>
  </form>;
}

// ---------------- generate ----------------

function GenerateView({ course, busy, preselected, onSubmit, onCancel }: {
  course: Course; busy: boolean; preselected: string; onCancel: () => void;
  onSubmit: (value: { material_ids: string[]; problem_set_ids: string[]; count: number; focus: string }) => Promise<void>;
}) {
  const realSets = (course.problem_sets || []).filter((set) => set.origin === "real");
  const [materialIds, setMaterialIds] = useState<string[]>([]);
  const [setIds, setSetIds] = useState<string[]>(preselected ? [preselected] : realSets.map((set) => set.id));
  const [count, setCount] = useState(5);
  const [focus, setFocus] = useState("");
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
  return <form className="pb-import" onSubmit={(event) => { event.preventDefault(); void onSubmit({ material_ids: materialIds, problem_set_ids: setIds, count, focus }); }}>
    <header className="pb-head">
      <div><h2>按 PDF 和真题标准出单元题</h2><p>内容来自所选课程 PDF，题型、难度和格式对齐所选真题，像同一位老师出的下一份 problem set。所选 PDF 和真题（含截图）会发送给 AI。</p></div>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
    </header>
    <div className="pb-two">
      <fieldset className="pb-pick"><legend>1 · 本单元的课程 PDF</legend>
        {course.materials.map((material) => <button type="button" key={material.id} className={`pb-option ${materialIds.includes(material.id) ? "is-on" : ""}`} onClick={() => setMaterialIds((ids) => toggle(ids, material.id))} aria-pressed={materialIds.includes(material.id)}>
          <span className="pb-tick">{materialIds.includes(material.id) && <Check size={12} />}</span><span>{material.name}</span>{material.week && <small>{material.week}</small>}
        </button>)}
      </fieldset>
      <fieldset className="pb-pick"><legend>2 · 参照的真题</legend>
        {realSets.map((set) => <button type="button" key={set.id} className={`pb-option ${setIds.includes(set.id) ? "is-on" : ""}`} onClick={() => setSetIds((ids) => toggle(ids, set.id))} aria-pressed={setIds.includes(set.id)}>
          <span className="pb-tick">{setIds.includes(set.id) && <Check size={12} />}</span><span>{set.title}</span><small>{set.problems.length} 道</small>
        </button>)}
      </fieldset>
    </div>
    <div className="pb-row">
      <label className="pb-field pb-count">题目数量<input type="number" min={1} max={12} value={count} onChange={(event) => setCount(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} /></label>
      <label className="pb-field pb-grow">补充要求（可选）<input value={focus} onChange={(event) => setFocus(event.target.value)} maxLength={1000} placeholder="例如：多出计算题，每题带小问" /></label>
    </div>
    <footer className="pb-foot">
      <span className="pb-hint">生成的题标为 AI 出题，可以修改后再练。</span>
      <Button type="submit" disabled={busy || !materialIds.length || !setIds.length}><Sparkles />开始出题</Button>
    </footer>
  </form>;
}

// ---------------- set ----------------

function SetView({ course, set, busy, statuses, actions, rename, remove, link, generate, unitBlocked }: {
  course: Course; set: ProblemSet; busy: boolean; statuses: Map<string, ProblemStatus>; actions: Actions;
  rename: (title: string, instructions: string) => Promise<Course | undefined>;
  remove: () => void; link?: () => void;
  generate: () => void; unitBlocked: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [renaming, setRenaming] = useState(false);
  const statusOf = (problem: Problem) => statuses.get(problemRef(set, problem)) || "new";
  const counts = { all: set.problems.length, new: 0, failed: 0, uncertain: 0, passed: 0 } as Record<Filter, number>;
  set.problems.forEach((problem) => { counts[statusOf(problem)] += 1; });
  const shown = set.problems.filter((problem) => filter === "all" || statusOf(problem) === filter);
  const next = set.problems.find((problem) => statusOf(problem) !== "passed" && problem.node_ids.some((id) => course.nodes.some((node) => node.id === id)));
  const canCrop = set.files.some((file) => file.kind === "pdf");

  return <div className="pb-set-view">
    <header className="pb-head">
      {renaming ? <RenameForm set={set} busy={busy} onCancel={() => setRenaming(false)} onSave={async (title, instructions) => { if (await rename(title, instructions)) setRenaming(false); }} />
      : <div className="min-w-0">
        <p className="pb-eyebrow">{set.origin === "real" ? "真题" : "AI 按真题出题"}{set.files.length > 0 && ` · ${set.files.map((file) => `${file.role === "answer" ? "答案" : "题目"}：${file.name}`).join("　")}`}</p>
        <h2>{set.title}</h2>
        <div className="pb-progress">
          <span className="pb-bar pb-bar-lg" aria-hidden><span style={{ width: `${counts.all ? (counts.passed / counts.all) * 100 : 0}%` }} /></span>
          <span>{counts.passed}/{counts.all} 道通过</span>
        </div>
      </div>}
      {!renaming && <div className="pb-actions">
        <Button size="sm" disabled={busy || !next} title={next ? "从第一道还没通过的题开始" : "先给题目关联知识点"} onClick={() => next && actions.practise(next, next.node_ids.find((id) => course.nodes.some((node) => node.id === id))!)}><Play />{counts.passed ? "继续练习" : "开始练习"}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="outline" aria-label="更多操作"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {set.origin === "real" && <DropdownMenuItem disabled={!!unitBlocked} onSelect={generate}><Wand2 />按这份真题出单元题</DropdownMenuItem>}
            {link && <DropdownMenuItem onSelect={link}><Sparkles />AI 重新关联知识点（保留手动关联）</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => setRenaming(true)}><Pencil />重命名 / 总说明</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={remove}><Trash2 />删除这份题</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
    </header>
    {set.standard && <p className="pb-note"><Sparkles size={14} /><span><b>AI 归纳的出题标准</b>{set.standard}</span></p>}
    {set.instructions && !renaming && <p className="pb-note pb-note-plain"><span><b>总说明</b>{set.instructions}</span></p>}
    <nav className="pb-tabs" aria-label="按练习状态筛选">
      {(["all", "new", "failed", "uncertain", "passed"] as Filter[]).filter((key) => key === "all" || counts[key] > 0).map((key) =>
        <button key={key} className={filter === key ? "is-on" : ""} onClick={() => setFilter(key)} aria-pressed={filter === key}>
          {key === "all" ? "全部" : STATUS_LABEL[key]}<span>{counts[key]}</span>
        </button>)}
    </nav>
    {!next && set.problems.length > 0 && <p className="pb-tip"><Link2 size={14} />给题目关联知识点后就能直接练习：点题目上的「关联知识点」。</p>}
    <div className="pb-list">
      {shown.map((problem) => <ProblemCard key={problem.id} course={course} set={set} problem={problem} status={statusOf(problem)} busy={busy}
        canCrop={canCrop} actions={actions} />)}
    </div>
  </div>;
}

function RenameForm({ set, busy, onSave, onCancel }: { set: ProblemSet; busy: boolean; onSave: (title: string, instructions: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(set.title);
  const [instructions, setInstructions] = useState(set.instructions || "");
  return <form className="pb-rename" onSubmit={(event) => { event.preventDefault(); onSave(title.trim(), instructions); }}>
    <label className="pb-field">名称<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} autoFocus /></label>
    <label className="pb-field">总说明（练习时附在每道题前）<textarea rows={2} value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={4000} /></label>
    <div className="pb-actions"><Button type="button" size="sm" variant="ghost" onClick={onCancel}>取消</Button><Button type="submit" size="sm" disabled={busy || !title.trim()}>保存</Button></div>
  </form>;
}

function ProblemCard({ course, set, problem, status, busy, canCrop, actions, practiseNode, showSource }: {
  course: Course; set: ProblemSet; problem: Problem; status: ProblemStatus; busy: boolean; canCrop: boolean; actions: Actions;
  /** In the by-node view the card practises on that node directly. */
  practiseNode?: string; showSource?: boolean;
}) {
  const onPractise = (nodeId: string) => actions.practise(problem, nodeId);
  const onChange = (change: Partial<Problem> | null) => actions.change(problem, change);
  const onAddImages = (files: File[], target: "images" | "answer_images") => actions.addImages(problem, files, target);
  const onCrop = (target: "images" | "answer_images") => actions.openCrop(problem, target);
  const [showAnswer, setShowAnswer] = useState(false);
  const [editing, setEditing] = useState(false);
  const blankDraft = () => ({ number: problem.number, text: problem.text, answer: problem.answer, keyPoints: (problem.key_points || []).join("\n") });
  const [draft, setDraft] = useState(blankDraft);
  const upload = useRef<HTMLInputElement>(null);
  const [uploadTarget, setUploadTarget] = useState<"images" | "answer_images">("images");
  const main = problem.node_ids.map((id) => course.nodes.find((node) => node.id === id)).find((node) => node !== undefined);
  const related = (problem.related_node_ids || []).map((id) => course.nodes.find((node) => node.id === id)).filter((node) => node !== undefined);
  // Moving the main node keeps the old one as a related reference, so no link is silently lost.
  const setMain = (nodeId: string) => onChange({ node_ids: [nodeId],
    related_node_ids: [...(main ? [main.id] : []), ...(problem.related_node_ids || [])].filter((id) => id !== nodeId) });
  const images = problem.images || [];
  const answerImages = problem.answer_images || [];
  const hasAnswer = Boolean(problem.answer || answerImages.length);
  const pick = (target: "images" | "answer_images") => { setUploadTarget(target); requestAnimationFrame(() => upload.current?.click()); };

  return <article className={`pb-card is-${status}`} tabIndex={-1}
    onPaste={(event) => { const pasted = pastedImages(event); if (pasted.length && !editing) { event.preventDefault(); void onAddImages(pasted, showAnswer ? "answer_images" : "images"); } }}>
    <header className="pb-card-head">
      <span className="pb-num">{problem.number || "·"}</span>
      <span className={`pb-status is-${status}`}>{STATUS_LABEL[status]}</span>
      {problem.kind && <span className="pb-kind">{problem.kind}</span>}
      {showSource && <span className="pb-kind" title="来自哪份题">{set.origin === "ai" ? "AI · " : ""}{set.title}</span>}
      <div className="pb-nodes">
        <label className={`pb-chip ${main ? "pb-chip-main" : "pb-chip-add"}`} title={main ? "这道题属于这个知识点；点一下可以改挂到别的知识点" : undefined}>
          <Link2 size={12} />{main ? main.title : "挂到知识点"}
          <select aria-label={main ? `改挂到其他知识点（现在：${main.title}）` : "挂到知识点"} value="" disabled={busy} onChange={(event) => event.target.value && void setMain(event.target.value)}>
            <option value="">{main ? "改挂到…" : "选择知识点…"}</option>
            {course.nodes.filter((node) => node.id !== main?.id).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select></label>
        {main && <button className="pb-chip-x" aria-label={`取消挂到 ${main.title}`} title="取消归属" disabled={busy} onClick={() => void onChange({ node_ids: [] })}><X size={11} /></button>}
        {related.length > 0 && <span className="pb-related" title="这些知识点出题时会参考这道题，但不算它们的题">
          也作参考：{related.map((node, index) => <span key={node.id}>{index > 0 && "、"}{node.title}
            <button aria-label={`不再作为 ${node.title} 的参考`} disabled={busy} onClick={() => void onChange({ related_node_ids: (problem.related_node_ids || []).filter((id) => id !== node.id) })}><X size={10} /></button></span>)}
        </span>}
      </div>
      <div className="pb-card-actions">
        {practiseNode ? <Button size="sm" variant={status === "passed" ? "outline" : "default"} disabled={busy} onClick={() => onPractise(practiseNode)}><Play />练这道</Button>
        : main && <Button size="sm" variant={status === "passed" ? "outline" : "default"} disabled={busy} onClick={() => onPractise(main.id)}><Play />练这道</Button>}
        {hasAnswer && <Button size="sm" variant="ghost" onClick={() => setShowAnswer((value) => !value)} aria-pressed={showAnswer}>{showAnswer ? <EyeOff /> : <Eye />}答案</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="题目操作"><Ellipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canCrop && <DropdownMenuItem onSelect={() => onCrop("images")}><Crop />在原页重新截题目</DropdownMenuItem>}
            {canCrop && <DropdownMenuItem onSelect={() => onCrop("answer_images")}><Crop />在原页截答案</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => pick("images")}><ImagePlus />上传题目截图</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => pick("answer_images")}><ImagePlus />上传答案截图</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setDraft(blankDraft()); setEditing(true); }}><Pencil />编辑题号、文字和考点</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => { if (window.confirm("删除这道题？")) void onChange(null); }}><Trash2 />删除这道题</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input ref={upload} type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden onChange={(event) => { const chosen = Array.from(event.target.files || []); event.target.value = ""; if (chosen.length) void onAddImages(chosen, uploadTarget); }} />
      </div>
    </header>
    {editing ? <form className="pb-edit" onSubmit={async (event) => { event.preventDefault(); const { keyPoints, ...fields } = draft;
      if (await onChange({ ...fields, key_points: keyPoints.split(/\n|；|;/).map((point) => point.trim()).filter(Boolean).slice(0, 8) })) setEditing(false); }}>
      <label className="pb-field pb-count">题号<input value={draft.number} onChange={(event) => setDraft({ ...draft, number: event.target.value })} maxLength={40} /></label>
      <label className="pb-field">题目文字（截图为准，文字用于搜索和 AI 提示）<textarea rows={4} value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} /></label>
      <label className="pb-field">答案文字<textarea rows={3} value={draft.answer} onChange={(event) => setDraft({ ...draft, answer: event.target.value })} /></label>
      <label className="pb-field">考点（每行一个，中英都写更好对上知识点，例如“主键 / primary key”）<textarea rows={3} value={draft.keyPoints} onChange={(event) => setDraft({ ...draft, keyPoints: event.target.value })} /></label>
      <div className="pb-actions"><Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button><Button type="submit" size="sm" disabled={busy || (!draft.text.trim() && !images.length)}>保存</Button></div>
    </form>
    : images.length ? <Shots course={course} set={set} images={images} busy={busy} label="题目" onRemove={(id) => void onChange({ images: images.filter((image) => image.id !== id) })} />
    : <p className="pb-text">{problem.text}</p>}
    {showAnswer && !editing && <div className="pb-answer">
      <p className="pb-eyebrow">参考答案</p>
      {answerImages.length > 0 && <Shots course={course} set={set} images={answerImages} busy={busy} label="答案" onRemove={(id) => void onChange({ answer_images: answerImages.filter((image) => image.id !== id) })} />}
      {problem.answer && (!answerImages.length ? <p className="pb-text">{problem.answer}</p> : <details><summary>答案文字</summary><p className="pb-text">{problem.answer}</p></details>)}
    </div>}
    {!editing && !!problem.key_points?.length && <div className="pb-points" title="AI 关联时提炼的考点，用来给其他知识点找内容相近的参考题">
      <span>考点</span>{problem.key_points.map((point) => <span key={point} className="pb-point">{point}</span>)}</div>}
    {!!problem.sources?.length && <p className="pb-hint">依据：{problem.sources.map((source) => `${course.materials.find((material) => material.id === source.material_id)?.name || "材料"} 第 ${source.page} 页`).join("；")}</p>}
  </article>;
}

function Shots({ course, set, images, label, busy, onRemove }: { course: Course; set: ProblemSet; images: ProblemImage[]; label: string; busy: boolean; onRemove: (id: string) => void }) {
  return <div className="pb-shots">{images.map((image, index) => <figure key={image.id} className="pb-shot">
    <a href={img(course.id, set, image)} target="_blank" rel="noreferrer" title="打开原图">
      {/* Natural size on high-density screens: a 216 dpi cut is shown at a third of its pixels. */}
      <img src={img(course.id, set, image)} alt={`${label}截图 ${index + 1}`} loading="lazy" decoding="async" style={{ maxWidth: Math.max(320, Math.round(image.width / 2)) }} />
    </a>
    <button className="pb-shot-remove" aria-label={`移除${label}截图 ${index + 1}`} disabled={busy} onClick={() => { if (window.confirm(`移除这张${label}截图？`)) onRemove(image.id); }}><X size={13} /></button>
  </figure>)}</div>;
}

// ---------------- crop ----------------

function CropDialog({ course, set, files, target, busy, onClose, onCrop }: {
  course: Course; set: ProblemSet; files: ProblemSet["files"]; target: CropTarget; busy: boolean;
  onClose: () => void;
  onCrop: (value: { file_id: string; page: number; box: number[]; target: "images" | "answer_images"; replace: boolean }) => void;
}) {
  const answerFile = files.find((file) => file.role === "answer");
  const initialFile = target.target === "answer_images" && answerFile ? answerFile : files.find((file) => file.id === target.problem.file_id) || files[0];
  const [fileId, setFileId] = useState(initialFile.id);
  const [page, setPage] = useState(target.target === "images" && target.problem.file_id === initialFile.id ? target.problem.pages?.[0] || 1 : 1);
  const [box, setBox] = useState<number[] | null>(null);
  const [replace, setReplace] = useState(true);
  const frame = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);
  const file = files.find((item) => item.id === fileId)!;
  const pages = file.page_count || 1;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const point = (event: ReactPointerEvent): [number, number] => {
    const rect = frame.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))];
  };
  const go = (next: number) => { setPage(Math.min(pages, Math.max(1, next))); setBox(null); };
  return <div className="pb-crop" role="dialog" aria-label="在原页框选截图">
    <header className="pb-crop-head">
      <strong>{target.target === "images" ? "重新截题目" : "截取答案"} · 第 {target.problem.number || "?"} 题</strong>
      {files.length > 1 && <select value={fileId} onChange={(event) => { setFileId(event.target.value); setPage(1); setBox(null); }} aria-label="选择 PDF">
        {files.map((item) => <option key={item.id} value={item.id}>{item.role === "answer" ? "答案" : "题目"}：{item.name}</option>)}
      </select>}
      <div className="pb-pager">
        <Button size="icon-sm" variant="ghost" disabled={page <= 1} onClick={() => go(page - 1)} aria-label="上一页"><ChevronLeft /></Button>
        <span>{page} / {pages}</span>
        <Button size="icon-sm" variant="ghost" disabled={page >= pages} onClick={() => go(page + 1)} aria-label="下一页"><ChevronRight /></Button>
      </div>
      <label className="pb-check"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />替换原有截图</label>
      <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
      <Button size="sm" disabled={busy || !box} onClick={() => box && onCrop({ file_id: fileId, page, box, target: target.target, replace })}><Check />使用这块截图</Button>
    </header>
    <p className="pb-hint pb-crop-hint">在页面上拖出一个框，截图按 216 dpi 原清晰度保存。</p>
    <div className="pb-crop-stage">
      <div ref={frame} className="pb-crop-frame"
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); setBox(null); }}
        onPointerMove={(event) => { if (!start.current) return; const [x, y] = point(event); const [sx, sy] = start.current; setBox([Math.min(sx, x), Math.min(sy, y), Math.max(sx, x), Math.max(sy, y)]); }}
        onPointerUp={() => { start.current = null; setBox((value) => value && (value[2] - value[0]) * (value[3] - value[1]) > 0.0005 ? value : null); }}>
        <img src={problemPageUrl(course.id, set.id, fileId, page)} alt={`第 ${page} 页`} draggable={false} />
        {box && <span className="pb-crop-box" style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%` }} />}
      </div>
    </div>
  </div>;
}

