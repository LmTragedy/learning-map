import { useState } from "react";
import { CheckCircle2, Circle, CircleDot, Plus, RefreshCw, Sparkles, Target } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { GoalEditor } from "./GoalEditor";
import { editableGoal, emptyGoal, readyToFinish } from "./goalFields";
import { GoalDetail } from "./GoalDetail";
import { GoalCandidates } from "./GoalCandidates";
import type { Course, Goal, GoalFields, GoalPreview } from "./types";
import "./goals.css";

const GOAL_DRAG = "application/x-learning-map-goal";

const columns = [
  { status: "todo", label: "待开始", Icon: Circle, empty: "没有待开始的目标" },
  { status: "doing", label: "进行中", Icon: CircleDot, empty: "把目标拖到这里开始" },
  { status: "done", label: "已完成", Icon: CheckCircle2, empty: "确认完成的目标会出现在这里" },
] as const;

export function GoalBoard({ course, initialGoalId = "", busy, aiEnabled, run, onRefresh, onNode }: {
  course: Course; initialGoalId?: string; busy: boolean; aiEnabled: boolean;
  run: <T,>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  onRefresh: (course: Course) => void; onNode: (nodeId: string, destination: "node" | "chat") => void;
}) {
  const [selectedId, setSelectedId] = useState(initialGoalId);
  const [editor, setEditor] = useState<{ goal: GoalFields; id?: string; revision: number }>();
  const [preview, setPreview] = useState<GoalPreview>();
  const [error, setError] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const goals = course.goals || [];
  const selected = goals.find((goal) => goal.id === selectedId);
  async function perform<T,>(action: () => Promise<T>) {
    setError("");
    return run("goal", async () => {
      try { return await action(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "目标操作失败"); throw failure; }
    });
  }
  async function save(fields: GoalFields) {
    if (!editor) return;
    const updated = await perform(() => editor.id
      ? api.updateGoal(course.id, editor.id, { ...fields, revision: editor.revision })
      : api.addGoal(course.id, fields));
    if (updated) { onRefresh(updated); setSelectedId(editor.id || updated.goals?.at(-1)?.id || ""); setEditor(undefined); }
  }
  async function update(goal: Goal, fields: Partial<GoalFields>) {
    const updated = await perform(() => api.updateGoal(course.id, goal.id, { ...editableGoal(goal), ...fields, revision: course.revision }));
    if (updated) onRefresh(updated);
  }
  async function extract() {
    const extracted = await perform(() => api.goalCandidates(course.id));
    if (extracted) { setPreview(extracted); setEditor(undefined); }
  }
  async function accept(indices: number[]) {
    if (!preview) return;
    const updated = await perform(() => api.acceptGoals(course.id, preview.token, indices));
    if (updated) { onRefresh(updated); setPreview(undefined); }
  }
  return <div className="modal-body goal-dashboard">
    <div className="goal-toolbar">
      <div><h3><Target size={20} />{course.title}</h3><p className="goal-muted">{goals.length} 个目标 · {goals.filter((goal) => goal.status === "done").length} 个已确认完成</p></div>
      <div className="goal-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(() => api.course(course.id)).then((updated) => updated && onRefresh(updated))} title="读取最新节点进度"><RefreshCw />刷新进度</Button>
        {/* With no goals yet these live in the first-run block below instead. */}
        {(goals.length > 0 || !!editor || !!preview) && <>
        <Button size="sm" variant="outline" disabled={busy || !!editor || !!preview || !aiEnabled || !course.materials.length} onClick={() => void extract()} title={!aiEnabled ? "先在设置中开启 AI" : !course.materials.length ? "先导入课程材料" : "分析整门课程材料，确认后加入"}><Sparkles />从材料提取</Button>
        <Button size="sm" disabled={busy || !!editor || !!preview} onClick={() => { setEditor({ goal: emptyGoal, revision: course.revision }); }}><Plus />添加目标</Button>
        </>}
      </div>
    </div>
    <p className="goal-muted">节点进度是学习证据。小目标逐项勾选；目标达成由你确认。</p>
    {error && <p className="goal-error" role="alert">{error}</p>}
    {editor && editor.revision !== course.revision && <p className="goal-muted" role="status">课程已变化。请保留当前编辑内容，取消编辑后重新打开目标再保存。</p>}
    {preview && <GoalCandidates key={preview.token} course={course} preview={preview} busy={busy} onAccept={accept} onCancel={() => setPreview(undefined)} />}
    <div className={`goal-layout ${selected || editor ? "has-detail" : ""}`}>
      {/* First run: one block with the first action where the goals will appear, not three empty columns. */}
      {!goals.length && !editor && !preview ? <section className="goal-first-run">
        <Target size={20} aria-hidden />
        <div>
          <strong>还没有目标</strong>
          <p className="goal-muted">目标是你想用这门课做成的事，比如“能独立设计一个带外键的表”。它会把需要的知识点连成一条路线，在图上标出来。也可以在地图上选中一个知识点，点“设为目标终点”。</p>
        </div>
        <div className="goal-actions">
          <Button size="sm" disabled={busy} onClick={() => setEditor({ goal: emptyGoal, revision: course.revision })}><Plus />添加第一个目标</Button>
          {aiEnabled && !!course.materials.length && <Button size="sm" variant="outline" disabled={busy} onClick={() => void extract()}><Sparkles />从材料提取</Button>}
        </div>
      </section> :
      <div className="goal-columns">{columns.map(({ status, label, Icon, empty }) => <section className={`goal-column goal-${status} ${dropTarget === status ? "is-drop" : ""}`} key={status} aria-label={label}
        onDragOver={(event) => { if (event.dataTransfer.types.includes(GOAL_DRAG)) { event.preventDefault(); setDropTarget(status); } }}
        onDragLeave={() => setDropTarget("")}
        onDrop={(event) => {
          event.preventDefault(); setDropTarget("");
          const goal = goals.find((entry) => entry.id === event.dataTransfer.getData(GOAL_DRAG));
          if (goal && goal.status !== status) void update(goal, { status });
        }}>
        <h3><Icon size={17} />{label}<span>{goals.filter((goal) => goal.status === status).length}</span></h3>
        <div className="goal-card-list">{goals.filter((goal) => goal.status === status).map((goal) => <button key={goal.id} disabled={!!editor} draggable={!editor && !busy}
          onDragStart={(event) => { event.dataTransfer.setData(GOAL_DRAG, goal.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => setDropTarget("")}
          title="拖到其他列可改变状态" onClick={() => setSelectedId(goal.id === selectedId ? "" : goal.id)} className={`goal-card ${goal.id === selectedId ? "is-selected" : ""}`} aria-pressed={goal.id === selectedId}>
          <strong>{goal.title}</strong>
          {!!goal.progress?.subtasks_total && <span>小目标 {goal.progress.subtasks_done}/{goal.progress.subtasks_total}</span>}
          {!!goal.node_ids.length && <span>验收通过 {goal.progress?.verified || 0}/{goal.node_ids.length} 个节点</span>}
          {readyToFinish(goal) && <span className="goal-ready">条件已满足，可以确认完成</span>}
        </button>)}{!goals.some((goal) => goal.status === status) && <p className="goal-empty">{empty}</p>}</div>
      </section>)}</div>}
      {editor ? <aside className="goal-detail"><h3>{editor.id ? "编辑目标" : "添加目标"}</h3><GoalEditor key={`${editor.id || "new"}:${editor.revision}`} course={course} initial={editor.goal} busy={busy} onSave={save} onCancel={() => setEditor(undefined)} /></aside>
        : selected && <GoalDetail course={course} goal={selected} busy={busy || !!preview}
          onEdit={() => setEditor({ goal: editableGoal(selected), id: selected.id, revision: course.revision })}
          onUpdate={(fields) => update(selected, fields)} onNode={onNode} />}
    </div>
  </div>;
}
