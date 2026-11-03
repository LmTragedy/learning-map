import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { STRENGTH_LABEL } from "./bridges";
import { PIECE_KINDS, type Bridge, type Course, type LearningNode, type PieceKind, type Strength } from "./types";

type Act = (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
const field = "rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground";

type BridgeForm = { id: string; from_piece: string; to_step: string; how: string; if_missing: string; strength: Strength; question: string; answer: string };

const toForm = (bridge: Bridge): BridgeForm => ({
  id: bridge.legacy ? "" : bridge.id, from_piece: bridge.from_piece, to_step: bridge.to_step, how: bridge.how,
  if_missing: bridge.if_missing, strength: bridge.strength, question: bridge.check.question, answer: bridge.check.answer,
});

/** Edit every bridge of one relationship at once; saving marks them as the user's and keeps them from AI rewrites. */
export function BridgeEditor({ course, edge, source, target, busy, act, onDone }: {
  course: Course; edge: Course["edges"][number]; source: LearningNode; target: LearningNode; busy: boolean; act: Act; onDone: () => void;
}) {
  const [rows, setRows] = useState<BridgeForm[]>(() => (edge.bridges || []).map(toForm));
  const update = (index: number, patch: Partial<BridgeForm>) => setRows((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row));
  const save = async () => {
    const saved = await act("bridges", () => api.editBridges(course.id, edge.id, course.revision, rows.map((row) => ({
      id: row.id, from_piece: row.from_piece, to_step: row.to_step, how: row.how, if_missing: row.if_missing,
      strength: row.strength, check: { question: row.question, answer: row.answer },
    }))));
    if (saved) onDone();
  };
  return <form className="mt-3 flex flex-col gap-2.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    {rows.map((row, index) => <fieldset key={index} className="grid gap-1.5 rounded-lg border border-border p-2.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-2"><strong className="flex-1 text-foreground">第 {index + 1} 座桥</strong>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="删除这座桥" onClick={() => setRows((current) => current.filter((_, i) => i !== index))}><Trash2 /></Button></div>
      <label className="grid gap-1">用到「{source.title}」的哪一块
        <select className={field} value={row.from_piece} onChange={(event) => update(index, { from_piece: event.target.value })}>
          <option value="">未指定</option>
          {(source.pieces || []).map((piece) => <option key={piece.id} value={piece.id}>{piece.kind}：{piece.title}</option>)}
        </select></label>
      <label className="grid gap-1">用在「{target.title}」的哪一步
        <select className={field} value={row.to_step} onChange={(event) => update(index, { to_step: event.target.value })}>
          <option value="">未指定</option>
          {(target.steps || []).map((step, i) => <option key={step.id} value={step.id}>第 {i + 1} 步 · {step.title}</option>)}
        </select></label>
      <label className="grid gap-1">怎么用（一句话）<input className={field} required value={row.how} onChange={(event) => update(index, { how: event.target.value })} /></label>
      <label className="grid gap-1">不会会怎样<input className={field} value={row.if_missing} onChange={(event) => update(index, { if_missing: event.target.value })} /></label>
      <label className="grid gap-1">强度
        <select className={field} value={row.strength} onChange={(event) => update(index, { strength: event.target.value as Strength })}>
          {(Object.keys(STRENGTH_LABEL) as Strength[]).map((key) => <option key={key} value={key}>{STRENGTH_LABEL[key]}</option>)}
        </select></label>
      <label className="grid gap-1">检验题<input className={field} value={row.question} onChange={(event) => update(index, { question: event.target.value })} /></label>
      <label className="grid gap-1">参考答案<input className={field} value={row.answer} onChange={(event) => update(index, { answer: event.target.value })} /></label>
    </fieldset>)}
    <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setRows((current) => [...current, { id: "", from_piece: "", to_step: "", how: "", if_missing: "", strength: "required", question: "", answer: "" }])}><Plus /> 加一座桥</Button>
    <p className="text-xs text-muted-foreground">保存后这些桥算你写的：之后 AI 补充时不会覆盖。强度只用于推荐，解锁仍按整个知识点。</p>
    <div className="flex justify-end gap-2"><Button size="sm" type="button" variant="ghost" onClick={onDone}>取消</Button><Button size="sm" disabled={busy}>保存知识桥</Button></div>
  </form>;
}

/** Pieces of a node (what later nodes can use) and its ordered steps (where it uses earlier ones). */
export function PieceEditor({ course, node, busy, act, onDone }: { course: Course; node: LearningNode; busy: boolean; act: Act; onDone: () => void }) {
  const [pieces, setPieces] = useState(() => (node.pieces || []).map(({ id, kind, title, detail }) => ({ id, kind, title, detail })));
  const [steps, setSteps] = useState(() => (node.steps || []).map(({ id, title }) => ({ id, title })));
  const save = async () => {
    const saved = await act("pieces", () => api.editPieces(course.id, node.id, course.revision, pieces, steps));
    if (saved) onDone();
  };
  return <form className="mt-2 flex flex-col gap-2 text-xs text-muted-foreground" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <strong className="text-foreground">「{node.title}」拆成的块</strong>
    {pieces.map((piece, index) => <div key={index} className="flex gap-1.5">
      <select className={field} value={piece.kind} aria-label="块的类型" onChange={(event) => setPieces((current) => current.map((row, i) => i === index ? { ...row, kind: event.target.value as PieceKind } : row))}>
        {PIECE_KINDS.map((kind) => <option key={kind}>{kind}</option>)}
      </select>
      <input className={`${field} min-w-0 flex-1`} required aria-label="块的名称" value={piece.title} onChange={(event) => setPieces((current) => current.map((row, i) => i === index ? { ...row, title: event.target.value } : row))} />
      <Button type="button" size="icon-sm" variant="ghost" aria-label="删除这一块" onClick={() => setPieces((current) => current.filter((_, i) => i !== index))}><Trash2 /></Button>
    </div>)}
    <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setPieces((current) => [...current, { id: "", kind: "定义", title: "", detail: "" }])}><Plus /> 加一块</Button>
    <strong className="mt-1 text-foreground">「{node.title}」的步骤（按顺序）</strong>
    {steps.map((step, index) => <div key={index} className="flex items-center gap-1.5">
      <span className="w-12 shrink-0">第 {index + 1} 步</span>
      <input className={`${field} min-w-0 flex-1`} required aria-label={`第 ${index + 1} 步`} value={step.title} onChange={(event) => setSteps((current) => current.map((row, i) => i === index ? { ...row, title: event.target.value } : row))} />
      <Button type="button" size="icon-sm" variant="ghost" aria-label="删除这一步" onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}><Trash2 /></Button>
    </div>)}
    <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setSteps((current) => [...current, { id: "", title: "" }])}><Plus /> 加一步</Button>
    <div className="flex justify-end gap-2"><Button size="sm" type="button" variant="ghost" onClick={onDone}>取消</Button><Button size="sm" disabled={busy}>保存</Button></div>
  </form>;
}
