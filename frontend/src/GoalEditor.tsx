import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { editableGoal } from "./goalFields";
import { SelectAll } from "./SelectAll";
import type { Course, GoalFields } from "./types";

export function GoalEditor({ course, initial, busy, onSave, onCancel }: {
  course: Course; initial: GoalFields; busy: boolean;
  onSave: (goal: GoalFields) => Promise<void>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => editableGoal(initial));
  const [query, setQuery] = useState("");
  // Locked titles stay hidden, so they are searched by the same label the picker shows.
  const labelled = course.nodes.map((node, index) => ({ node, label: node.unlocked ? node.title : `未解锁知识点 ${index + 1}${node.week ? ` · ${node.week}` : ""}` }));
  const shown = labelled.filter(({ label }) => label.toLowerCase().includes(query.trim().toLowerCase()));
  const updateTask = (index: number, title: string) => setDraft({ ...draft,
    subtasks: draft.subtasks.map((task, offset) => offset === index ? { ...task, title } : task) });
  return <form className="goal-editor" onSubmit={(event) => { event.preventDefault(); void onSave(draft); }}
    onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.currentTarget.requestSubmit(); }
    }}>
    <label>目标名称<input autoFocus aria-label="目标名称" maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required /></label>
    <label>目标类型<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as GoalFields["kind"] })}><option value="course">课程目标</option><option value="personal">个人目标</option></select></label>
    <label>目标说明<textarea rows={3} maxLength={4000} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="怎样才算实现这个目标？" /></label>
    <fieldset><legend>关联知识点（可多选）</legend>
      {!!course.nodes.length && <div className="goal-picker-tools">
        <input type="search" aria-label="搜索知识点" placeholder="搜索知识点…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <SelectAll ids={shown.map(({ node }) => node.id)} selected={draft.node_ids} label={query ? "全选搜索结果" : "全选"}
          onChange={(next) => setDraft({ ...draft, node_ids: (next as string[]).slice(0, 100) })} />
      </div>}
      <div className="goal-node-picker">{shown.map(({ node, label }) => <label key={node.id} className="goal-check">
        <input type="checkbox" checked={draft.node_ids.includes(node.id)} disabled={!draft.node_ids.includes(node.id) && draft.node_ids.length >= 100} onChange={(event) => setDraft({ ...draft, node_ids: event.target.checked ? [...draft.node_ids, node.id] : draft.node_ids.filter((id) => id !== node.id) })} />
        {label}
      </label>)}</div>
      {!course.nodes.length && <p className="goal-muted">还没有知识点，可先保存目标，生成地图后再关联。</p>}
    </fieldset>
    <fieldset><legend>拆成小目标</legend>
      {draft.subtasks.map((task, index) => <div className="goal-task-edit" key={task.id || index}>
        <input aria-label={`小目标 ${index + 1}`} value={task.title} maxLength={200} required onChange={(event) => updateTask(index, event.target.value)} />
        <select aria-label={`小目标 ${index + 1} 关联知识点`} className="max-w-40 text-xs" value={task.node_id || ""} title="关联后，该知识点验收通过时自动勾选"
          onChange={(event) => setDraft({ ...draft, subtasks: draft.subtasks.map((entry, offset) => offset === index ? { ...entry, node_id: event.target.value } : entry) })}>
          <option value="">不关联知识点</option>
          {labelled.map(({ node, label }) => <option key={node.id} value={node.id}>{label}</option>)}
        </select>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除小目标 ${index + 1}`} onClick={() => setDraft({ ...draft, subtasks: draft.subtasks.filter((_, offset) => offset !== index) })}><X /></Button>
      </div>)}
      <Button type="button" size="sm" variant="ghost" disabled={draft.subtasks.length >= 50} onClick={() => setDraft({ ...draft, subtasks: [...draft.subtasks, { id: crypto.randomUUID(), title: "", done: false }] })}><Plus />添加小目标</Button>
    </fieldset>
    <div className="goal-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button><Button disabled={busy || !draft.title.trim() || draft.subtasks.some((task) => !task.title.trim())}>保存目标</Button></div>
  </form>;
}
