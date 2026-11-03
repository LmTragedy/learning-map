import { useState } from "react";
import { api } from "./api";
import { AnchoredNotes } from "./AnchoredNotes";
import { Button } from "./components/ui/button";
import { lineColor, linePercent } from "./lines";
import type { Course, LearningNode, Line } from "./types";

export function LinesPanel({ course, initialLineId, busy, aiEnabled, act, onNode, onNote }: {
  course: Course; initialLineId: string; busy: boolean; aiEnabled: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onNode: (node: LearningNode) => void; onNote: (node: LearningNode, noteId: string) => void;
}) {
  const [lineId, setLineId] = useState(initialLineId);
  const line = course.lines?.find((entry) => entry.id === lineId);
  const strict = course.review_scope.enabled && course.review_scope.ai_scope === "selected";
  const progress = course.progress;
  return <div className="modal-body">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={!line ? "secondary" : "outline"} onClick={() => setLineId("")}>课程全貌</Button>
      {(course.lines || []).map((entry) => <Button key={entry.id} size="sm" variant={line?.id === entry.id ? "secondary" : "outline"} onClick={() => setLineId(entry.id)}>
        <i className="size-2 rounded-full" style={{ background: lineColor(entry) }} />{entry.name}
      </Button>)}
    </div>
    {strict ? <p className="text-sm text-muted-foreground">当前只复习所选材料。退出复习后查看整门课的主线与串讲。</p> : <>
      {!line ? <>
        <p>{course.overview?.summary || "把知识点沿着知识桥连成主线，看看这一门课最终在解决什么问题。"}</p>
        {progress && <p className="text-sm text-muted-foreground">已掌握知识块 {progress.pieces.known}/{progress.pieces.total} · 已完成站点 {progress.nodes.done}/{progress.nodes.total}</p>}
        {!!course.overview?.abilities.length && <ul className="list-disc pl-5">{course.overview.abilities.map((text, index) => <li key={index}>{text}</li>)}</ul>}
        <Button disabled={busy || !aiEnabled || !course.nodes.length} onClick={() => void act("generate-lines", () => api.generateLines(course.id))}>用 AI {course.lines?.length ? "更新" : "生成"}主线与课程全貌</Button>
        <p className="text-xs text-muted-foreground">根据当前知识点和知识桥生成；AI 解释待核对。保留已编辑、有笔记或串讲记录的主线。</p>
        {(course.lines || []).map((entry) => <button key={entry.id} className="rounded-lg border border-border p-3 text-left" onClick={() => setLineId(entry.id)}>
          <strong style={{ color: lineColor(entry) }}>{entry.name}</strong><p>{entry.goal}</p><small>{linePercent(entry)}% · {entry.node_ids.length} 站 · {entry.endpoint}</small>
        </button>)}
      </> : <LineStory key={line.id} course={course} line={line} busy={busy} aiEnabled={aiEnabled} act={act} onNode={onNode} onNote={onNote} />}
    </>}
  </div>;
}

function LineStory({ course, line, busy, aiEnabled, act, onNode, onNote }: {
  course: Course; line: Line; busy: boolean; aiEnabled: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onNode: (node: LearningNode) => void; onNote: (node: LearningNode, noteId: string) => void;
}) {
  const [retelling, setRetelling] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(line.name);
  const [goal, setGoal] = useState(line.goal);
  const last = line.retells?.at(-1);
  const byId = new Map(course.nodes.map((node) => [node.id, node]));
  return <section className="grid gap-3">
    <h3 className="text-lg font-semibold" style={{ color: lineColor(line) }}>{line.name}</h3>
    <p>{line.goal}</p><p className="text-sm text-muted-foreground">学完能：{line.endpoint || "待补充"} · {linePercent(line)}% · {line.node_ids.length} 站</p>
    {editing && <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void act("edit-line", () => api.editLine(course.id, line.id, course.revision, { name, goal, node_ids: line.node_ids, endpoint: line.endpoint, story: line.story || [] })).then((saved) => saved && setEditing(false)); }}>
      <label>主线名称<input aria-label="主线名称" value={name} required maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label>一句话目标<input aria-label="主线目标" value={goal} maxLength={400} onChange={(event) => setGoal(event.target.value)} /></label>
      <Button disabled={busy || !name.trim()}>保存主线</Button>
    </form>}
    <Button className="justify-self-start" size="sm" variant="ghost" onClick={() => setEditing(!editing)}>编辑名称与目标</Button>
    {!retelling && <ol className="grid list-decimal gap-3 pl-5">{line.node_ids.map((id) => {
      const node = byId.get(id);
      return node && <li key={id}><button className="font-medium underline underline-offset-4" onClick={() => onNode(node)}>{node.title}</button>
        <p className="mt-1 text-sm text-muted-foreground">{line.story?.find((step) => step.node_id === id)?.text || "这站的串讲还未补充。"}</p></li>;
    })}</ol>}
    <Button className="justify-self-start" variant="outline" onClick={() => setRetelling(!retelling)}>{retelling ? "返回串讲" : "自己讲一遍（隐藏提示）"}</Button>
    {retelling && <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void act("retell", () => api.retellLine(course.id, line.id, text)); }}>
      <label htmlFor="line-retell">不用看提示，讲清每一站怎么连到下一站</label>
      <textarea id="line-retell" rows={6} maxLength={6000} value={text} onChange={(event) => setText(event.target.value)} />
      <Button disabled={busy || !aiEnabled || !text.trim()}>检查我的串讲</Button>
      {last && <div className="rounded-lg border border-border p-3"><p>{last.review.feedback}</p>{last.review.missing.map((gap, index) => {
        const node = byId.get(gap.node_id);
        return <p key={index} className="mt-2 text-sm">{gap.note} {node && <button className="underline" onClick={() => onNode(node)}>回看 {node.title}</button>}</p>;
      })}</div>}
    </form>}
    <AnchoredNotes course={course} anchor={{ kind: "line", id: line.id }} nodeIds={line.node_ids} title={line.name} busy={busy} act={act} onOpen={onNote} />
  </section>;
}
