import { useState } from "react";
import { ArrowRight, Pencil, Sparkles, X } from "lucide-react";
import { api, materialFileUrl } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { BridgeEditor, PieceEditor } from "./BridgeEditors";
import { AnchoredNotes } from "./AnchoredNotes";
import { needsBridges, pieceLabel, resolveBridges, stepLabel, STRENGTH_LABEL } from "./bridges";
import { RELATION_KINDS, type Course, type LearningNode, type RelationKind } from "./types";
import { TaskCards, useCourseTasks } from './aiTasks';

type Edge = Course["edges"][number];

const evidenceLabels: Record<string, string> = { material_quote: "引用材料原文", material_inference: "依据材料推论", ai_inference: "AI 推断" };

/** Everything about one link between two nodes: its bridges, the pieces and steps they join, and its sources. */
export function BridgeDetail({
  course, relation, busy, reviewStrict, run, onRefresh, onNavigateNode, onClose, onOpenReview, onExitReview, onNote,
}: {
  course: Course;
  relation: Edge;
  busy: boolean;
  reviewStrict: boolean;
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: (course: Course) => void;
  onNavigateNode: (node: LearningNode, edge?: Edge) => void;
  onClose: () => void;
  onOpenReview: () => void;
  onExitReview: () => void;
  onNote: (node: LearningNode, noteId: string) => void;
}) {
  const edge = relation.origin_relation_id ? course.edges.find((candidate) => candidate.id === relation.origin_relation_id) || relation : relation;
  const source = course.nodes.find((entry) => entry.id === edge.source);
  const target = course.nodes.find((entry) => entry.id === edge.target);
  const [editing, setEditing] = useState<"" | "bridges" | "pieces" | "steps" | "text">("");
  const act = async (key: string, fn: () => Promise<Course>) => {
    const updated = await run(key, fn);
    if (updated) onRefresh(updated);
    return updated;
  };
  const bridges = resolveBridges(course, [edge]);
  const synthesisNode = edge.synthesis_node_id
    ? course.nodes.find((entry) => entry.id === edge.synthesis_node_id)
    : course.nodes.find((entry) => entry.kind === "synthesis" && entry.relation_id === edge.id);
  const synthesisInScope = Boolean(synthesisNode && course.review_scope?.node_ids.includes(synthesisNode.id));
  const contrast = edge.kind === "对比";
  const taskLedger=useCourseTasks();
  const pendingEdge=taskLedger.tasks.some(t=>t.kind==='bridge'&&t.target===edge.id&&t.state!=='applied');
  // The batch run reports in the page banner; here it is only a tag, not a second copy of its card.
  const batch=taskLedger.tasks.find(t=>t.kind==='bridge'&&t.target==='batch'&&['active','attention'].includes(taskLedger.viewFor(t).group));
  const batchGroup=batch&&taskLedger.viewFor(batch).group;
  return <section className="rounded-xl border border-border bg-card p-3.5" aria-label="知识桥详情">
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <span className="t-meta">{edge.kind || "用到"} · {contrast ? "容易混淆，要分清" : `${bridges.length} 座知识桥`}</span>
        <h3 className="t-item mt-0.5 flex flex-wrap items-center gap-1">
          {source && <button className="cursor-pointer hover:underline" onClick={() => onNavigateNode(source, edge)}>{source.title}</button>}
          <ArrowRight size={13} className="text-muted-foreground" aria-hidden />
          {target && <button className="cursor-pointer hover:underline" onClick={() => onNavigateNode(target, edge)}>{target.title}</button>}
        </h3>
      </div>
      <Badge variant={edge.uncertain ? "warning" : edge.confirmed ? "passed" : "secondary"}>
        {edge.confirmed ? edge.uncertain ? "已核对 · 仍不确定" : "已核对" : "AI 建议 · 待核对"}
      </Badge>
      <Button variant="ghost" size="icon-sm" aria-label="关闭知识桥详情" title="返回节点详情" onClick={onClose}><X /></Button>
    </div>

    {!contrast && editing !== "bridges" && <div className="mt-3 flex flex-col gap-2">
      {bridges.map((item, index) => <div key={item.bridge.id} className="rounded-lg border border-border px-3 py-2 text-[13px] leading-relaxed">
        <div className="flex items-center gap-2">
          <strong className="min-w-0 flex-1">桥 {index + 1} · {pieceLabel(item)}</strong>
          <Badge variant={item.bridge.strength === "required" ? "passed" : "secondary"}>{STRENGTH_LABEL[item.bridge.strength]}</Badge>
        </div>
        {item.step && <p><span className="text-muted-foreground">用在 </span>{stepLabel(item)}</p>}
        {item.bridge.how && <p><span className="text-muted-foreground">怎么用 </span>{item.bridge.how}</p>}
        {item.bridge.if_missing && <p><span className="text-muted-foreground">不会会 </span>{item.bridge.if_missing}</p>}
        {item.bridge.check.question && <p className="mt-1 rounded-md bg-st-new/5 px-2 py-1"><span className="text-muted-foreground">检验 </span>{item.bridge.check.question}<span className="block text-muted-foreground">答：{item.bridge.check.answer}</span></p>}
        {item.bridge.legacy && <p className="t-meta mt-1">旧关系迁移而来：只知道“要先学它”，还不知道用到哪一块。</p>}
        {item.bridge.sources.map((entry, i) => <a key={i} className="t-meta mt-1 block hover:underline" target="_blank" rel="noreferrer" href={materialFileUrl(course.id, entry.material_id, entry.page)}>
          {course.materials.find((material) => material.id === entry.material_id)?.name || "课程材料"} · 第 {entry.page} 页{entry.quote ? ` · ${entry.quote}` : ""}</a>)}
      </div>)}
      {!bridges.length && <p className="t-meta">这条联系没有知识桥。</p>}
      {pendingEdge && <TaskCards kind="bridge" target={edge.id} />}
      {batch && needsBridges(edge) && <Badge variant={batchGroup==='attention'?'warning':'secondary'} className="self-start">{batchGroup==='attention'?'批量补充未完成 · 见页首':'批量补充中'}</Badge>}
      {!pendingEdge && !batch && needsBridges(edge) && <Button size="sm" variant="outline" className="self-start" disabled={busy}
        onClick={() => void act("backfill-relations", () => api.backfillRelation(course.id, edge.id, course.revision))}><Sparkles /> 用 AI 补充知识桥</Button>}
    </div>}
    {editing === "bridges" && source && target && <BridgeEditor key={course.revision} course={course} edge={edge} source={source} target={target} busy={busy} act={act} onDone={() => setEditing("")} />}
    {editing === "pieces" && source && <PieceEditor key={course.revision} course={course} node={source} busy={busy} act={act} onDone={() => setEditing("")} />}
    {editing === "steps" && target && <PieceEditor key={course.revision} course={course} node={target} busy={busy} act={act} onDone={() => setEditing("")} />}

    {(contrast || edge.explanation) && editing !== "text" && <OldText edge={edge} />}
    {editing === "text" && <TextEditor key={course.revision} course={course} edge={edge} busy={busy} act={act} onDone={() => setEditing("")} />}

    {!!edge.sources?.length && <div className="mt-2 flex flex-col gap-1.5">
      {edge.sources.map((entry, index) => {
        const material = course.materials.find((item) => item.id === entry.material_id);
        return <a className="rounded-md border border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent/40" target="_blank" rel="noreferrer" key={`${entry.material_id}-${entry.page}-${index}`}
          href={materialFileUrl(course.id, entry.material_id, entry.page)}>
          <strong className="block text-foreground">{material?.name || "课程材料"} · 第 {entry.page} 页</strong>{entry.quote || "打开原始页面查看"}
        </a>;
      })}
    </div>}
    {reviewStrict && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-st-new"><span>复习范围外的相关点不会自动加入本次材料范围。</span><Button size="sm" variant="ghost" onClick={onOpenReview}>调整范围</Button><Button size="sm" variant="ghost" onClick={onExitReview}>退出复习</Button></div>}
    <AnchoredNotes course={course} anchor={{ kind: "bridge", id: edge.id }} nodeIds={[edge.source, edge.target]} title={`${source?.title || "前站"} → ${target?.title || "后站"}`} busy={busy} act={act} onOpen={onNote} />
    <p className="t-meta mt-2">解锁仍按整个知识点；强度只用于推荐{edge.evidence_kind ? ` · ${evidenceLabels[edge.evidence_kind] || edge.evidence_kind}` : ""}。</p>

    <div className="mt-3 flex flex-wrap gap-1.5">
      {!edge.confirmed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("relation", () => api.confirmRelation(course.id, edge.id, course.revision))}>核对并确认</Button>}
      {!contrast && <EditToggle on={editing === "bridges"} onClick={() => setEditing(editing === "bridges" ? "" : "bridges")}>编辑知识桥</EditToggle>}
      {!contrast && <EditToggle on={editing === "pieces"} onClick={() => setEditing(editing === "pieces" ? "" : "pieces")}>编辑前一站的块</EditToggle>}
      {!contrast && <EditToggle on={editing === "steps"} onClick={() => setEditing(editing === "steps" ? "" : "steps")}>编辑后一站的步骤</EditToggle>}
      <EditToggle on={editing === "text"} onClick={() => setEditing(editing === "text" ? "" : "text")}>编辑说明</EditToggle>
      {edge.presentation !== "synthesis" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("relation", () => api.relationPresentation(course.id, edge.id, "synthesis", course.revision))}>切为综合节点</Button>}
      {edge.presentation === "synthesis" && synthesisNode && (!reviewStrict || synthesisInScope)
        && <Button size="sm" variant="outline" onClick={() => onNavigateNode(synthesisNode, edge)}><Sparkles />打开综合节点</Button>}
      {edge.presentation === "synthesis" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("relation", () => api.relationPresentation(course.id, edge.id, "simple", course.revision))}>改回简单关系</Button>}
    </div>
  </section>;
}

function EditToggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return <Button size="sm" variant="ghost" aria-pressed={on} onClick={onClick}><Pencil /> {children}</Button>;
}

function OldText({ edge }: { edge: Edge }) {
  const lines = [["说明", edge.explanation], ["何时用", edge.when_to_use], ["依据", edge.basis]]
    .filter(([, text]) => text && !String(text).startsWith("旧版关系未记录"));
  if (!lines.length) return null;
  return <div className={cn("mt-3 grid gap-1 rounded-lg bg-muted/40 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground")}>
    {lines.map(([label, text]) => <p key={label} className="whitespace-pre-line"><strong className="text-foreground">{label}：</strong>{text}</p>)}
  </div>;
}

function TextEditor({ course, edge, busy, act, onDone }: { course: Course; edge: Edge; busy: boolean; act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>; onDone: () => void }) {
  const kind: RelationKind = RELATION_KINDS.includes(edge.relation as RelationKind) ? edge.relation as RelationKind : edge.kind === "对比" ? "相似或对比" : "前置知识";
  const blank = (text?: string) => text && !text.startsWith("旧版关系未记录") ? text : "";
  const [form, setForm] = useState({
    relation: kind, explanation: blank(edge.explanation), when_to_use: blank(edge.when_to_use), basis: blank(edge.basis),
    forward_difficulty: edge.forward_difficulty || "初始估计 · 未验证", reverse_difficulty: edge.reverse_difficulty || "初始估计 · 未验证",
  });
  const save = async () => {
    const saved = await act("relation", () => api.editRelation(course.id, edge.id, { ...form, revision: course.revision }));
    if (saved) onDone();
  };
  const input = "rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground";
  return <form className="mt-3 grid gap-2 text-xs text-muted-foreground" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label className="grid gap-1">关系类型<select className={input} value={form.relation} onChange={(event) => setForm({ ...form, relation: event.target.value as RelationKind })}>
      {RELATION_KINDS.map((item) => <option key={item}>{item}</option>)}</select></label>
    <label className="grid gap-1">一句话说明<textarea className={`${input} min-h-14`} required value={form.explanation} onChange={(event) => setForm({ ...form, explanation: event.target.value })} /></label>
    <label className="grid gap-1">何时用<textarea className={`${input} min-h-12`} required value={form.when_to_use} onChange={(event) => setForm({ ...form, when_to_use: event.target.value })} /></label>
    <label className="grid gap-1">依据<input className={input} required value={form.basis} onChange={(event) => setForm({ ...form, basis: event.target.value })} /></label>
    <div className="flex justify-end gap-2"><Button size="sm" type="button" variant="ghost" onClick={onDone}>取消</Button><Button size="sm" disabled={busy}>保存说明</Button></div>
  </form>;
}
