import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { api, materialFileUrl } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { needsExplanation } from "./relationVisibility";
import { RELATION_KINDS, type Course, type LearningNode, type RelationKind } from "./types";

export function RelationPanel({
  course, relation, busy, reviewStrict, run, onRefresh, onNavigateNode, onClose, onOpenReview, onExitReview,
}: {
  course: Course;
  relation: Course["edges"][number];
  busy: boolean;
  reviewStrict: boolean;
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: (course: Course) => void;
  onNavigateNode: (node: LearningNode, edge?: Course["edges"][number]) => void;
  onClose: () => void;
  onOpenReview: () => void;
  onExitReview: () => void;
}) {
  const canonicalRelation = relation.origin_relation_id
    ? course.edges.find((candidate) => candidate.id === relation.origin_relation_id) || relation
    : relation;
  const canonicalTarget = course.nodes.find((entry) => entry.id === canonicalRelation.target);
  const controlsUnlock = canonicalRelation.controls_unlock ?? Boolean(canonicalTarget?.prerequisites.includes(canonicalRelation.source));
  const initialRelationKind: RelationKind = RELATION_KINDS.includes(canonicalRelation.relation as RelationKind)
    ? canonicalRelation.relation as RelationKind
    : controlsUnlock ? "前置知识" : "帮助理解";
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    relation: initialRelationKind,
    explanation: canonicalRelation.explanation || "",
    when_to_use: canonicalRelation.when_to_use || "",
    basis: canonicalRelation.basis || "",
    forward_difficulty: canonicalRelation.forward_difficulty || "",
    reverse_difficulty: canonicalRelation.reverse_difficulty || "",
  });
  const update = async (action: () => Promise<Course>) => {
    const updated = await run("relation", action);
    if (updated) onRefresh(updated);
  };
  const saveEdits = async () => {
    const updated = await run("relation", () => api.editRelation(course.id, canonicalRelation.id, { ...form, revision: course.revision }));
    if (updated) { onRefresh(updated); setEditing(false); }
  };
  const updateField = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const synthesisNode = canonicalRelation.synthesis_node_id
    ? course.nodes.find((entry) => entry.id === canonicalRelation.synthesis_node_id)
    : course.nodes.find((entry) => entry.kind === "synthesis" && entry.relation_id === canonicalRelation.id);
  const synthesisInScope = Boolean(synthesisNode && course.review_scope?.node_ids.includes(synthesisNode.id));
  const sourceNode = course.nodes.find((entry) => entry.id === canonicalRelation.source);
  const targetNode = canonicalTarget;
  const evidenceLabel = ({ material_quote: "引用材料原文 · 关系说明为 AI 解释", material_inference: "依据材料推论", ai_inference: "AI 推断" } as Record<string, string>)[canonicalRelation.evidence_kind || ""] || canonicalRelation.evidence_kind;
  const fields: { key: keyof typeof form; label: string; multiline?: boolean }[] = [
    { key: "relation", label: "关系类型" },
    { key: "explanation", label: "关系说明", multiline: true },
    { key: "when_to_use", label: "何时使用", multiline: true },
    { key: "basis", label: "依据", multiline: true },
    { key: "forward_difficulty", label: "正向难度估计" },
    { key: "reverse_difficulty", label: "反向难度估计" },
  ];
  return <section className="rounded-xl border border-border bg-card p-3.5" aria-label="关系详情">
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <h3 className="t-item">关系说明 · {canonicalRelation.relation || "相关联系"}</h3>
        <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{canonicalRelation.explanation || "暂无关系说明。"}</p>
        {needsExplanation(canonicalRelation) && <Button size="sm" variant="outline" className="mt-2" disabled={busy}
          onClick={() => void update(() => api.backfillRelations(course.id, course.revision))}><Sparkles />用 AI 补充说明</Button>}
      </div>
      <Badge variant={canonicalRelation.uncertain ? "warning" : canonicalRelation.confirmed ? "passed" : "secondary"}>
        {canonicalRelation.confirmed ? canonicalRelation.uncertain ? "已核对 · 仍不确定" : "已核对" : "AI 建议 · 待核对"}
      </Badge>
      <Button variant="ghost" size="icon-sm" aria-label="关闭关系详情" title="返回节点详情" onClick={onClose}><X /></Button>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{sourceNode?.title || "知识点"} → {targetNode?.title || "知识点"}</p>
    <p className="mt-2 text-xs"><strong>解锁：</strong>解锁由节点原有的先修条件决定；此关系{controlsUnlock ? "对应一项真实先修条件" : "仅作知识关联"}。</p>
    {canonicalRelation.when_to_use && <p className="mt-2 text-xs leading-relaxed"><strong>何时用：</strong><span className="text-muted-foreground">{canonicalRelation.when_to_use}</span></p>}
    {canonicalRelation.basis && <p className="mt-2 text-xs leading-relaxed"><strong>依据：</strong><span className="text-muted-foreground">{canonicalRelation.basis}</span></p>}
    {evidenceLabel && <p className="mt-2 text-xs text-muted-foreground">证据类型：{evidenceLabel}</p>}
    {!!canonicalRelation.sources?.length && <div className="mt-2 flex flex-col gap-1.5">
      {canonicalRelation.sources.map((source, index) => {
        const material = course.materials.find((item) => item.id === source.material_id);
        return <a className="rounded-md border border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent/40" target="_blank" rel="noreferrer" key={`${source.material_id}-${source.page}-${index}`}
          href={materialFileUrl(course.id, source.material_id, source.page)}>
          <strong className="block text-foreground">{material?.name || "课程材料"} · 第 {source.page} 页</strong>{source.quote || "打开原始页面查看"}<small className="mt-1 block">自动提取的原文引用 · 待核对</small>
        </a>;
      })}
    </div>}
    <div className="mt-3 grid gap-1.5 rounded-lg bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
      <span><strong className="text-foreground">正向：</strong>{canonicalRelation.forward_difficulty || "未提供"}</span>
      <span><strong className="text-foreground">反向：</strong>{canonicalRelation.reverse_difficulty || "未提供"}</span>
      <small>双向难度是未验证的初始估计；编辑后也仍是估计。</small>
    </div>
    {reviewStrict && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-st-new"><span>复习范围外的相关点不会自动加入本次材料范围。</span><Button size="sm" variant="ghost" onClick={onOpenReview}>调整范围</Button><Button size="sm" variant="ghost" onClick={onExitReview}>退出复习</Button></div>}
    {editing && <form className="mt-3 grid gap-2" onSubmit={(event) => {
      event.preventDefault();
      void saveEdits();
    }}>
      {fields.map(({ key, label, multiline }) => <label key={key} className="grid gap-1 text-xs text-muted-foreground">{label}
        {key === "relation"
          ? <select className="rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground" value={form[key]} onChange={(event) => updateField(key, event.target.value)}>
            {RELATION_KINDS.map((item) => <option key={item}>{item}</option>)}
          </select>
          : multiline
          ? <textarea className="min-h-16 resize-y rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground" value={form[key]} onChange={(event) => updateField(key, event.target.value)} required />
          : <input className="rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground" value={form[key]} onChange={(event) => updateField(key, event.target.value)} required />}
      </label>)}
      <p className="text-xs text-muted-foreground">保存编辑会撤销已核对状态；难度方向仍表示未验证的初始估计。</p>
      <div className="flex gap-2"><Button size="sm" disabled={busy}>保存说明</Button><Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>取消</Button></div>
    </form>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!canonicalRelation.confirmed && <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(() => api.confirmRelation(course.id, canonicalRelation.id, course.revision))}>核对并确认</Button>}
      <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>{editing ? "收起编辑" : "编辑说明"}</Button>
      {canonicalRelation.presentation !== "synthesis" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(() => api.relationPresentation(course.id, canonicalRelation.id, "synthesis", course.revision))}>切为综合节点</Button>}
      {canonicalRelation.presentation === "synthesis" && synthesisNode && (!reviewStrict || synthesisInScope)
        && <Button size="sm" variant="outline" onClick={() => onNavigateNode(synthesisNode, canonicalRelation)}><Sparkles />打开综合节点</Button>}
      {canonicalRelation.presentation === "synthesis" && synthesisNode && reviewStrict && !synthesisInScope
        && <span className="self-center text-xs text-st-new">综合节点不在当前复习范围内</span>}
      {canonicalRelation.presentation === "synthesis" && !synthesisNode && <span className="self-center text-xs text-muted-foreground">综合节点尚未返回</span>}
      {canonicalRelation.presentation === "synthesis" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(() => api.relationPresentation(course.id, canonicalRelation.id, "simple", course.revision))}>改回简单关系</Button>}
    </div>
  </section>;
}
