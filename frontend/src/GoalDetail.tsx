import { Map, MessageCircle } from "lucide-react";
import { Button } from "./components/ui/button";
import type { Course, Goal, GoalFields, LearningNode } from "./types";
import { readyToFinish } from "./goalFields";
import { materialFileUrl } from "./api";

function progressLabel(node: LearningNode) {
  if (node.verification === "review") return "待复查";
  if (node.verification === "ai_passed") return "系统验收通过";
  if (node.verification === "user_passed") return "用户确认通过";
  if (node.status === "mastered") return "自我掌握 · 未经验收";
  if (node.status === "studied") return "学过 · 未经验收";
  return "未学习";
}

function LinkedGoalNode({ course, id, busy, onNode }: {
  course: Course; id: string; busy: boolean;
  onNode: (nodeId: string, destination: "node" | "chat") => void;
}) {
  const node = course.nodes.find((entry) => entry.id === id);
  if (!node) return <p className="goal-muted">关联知识点不可用</p>;
  const outside = course.review_scope?.enabled && !course.review_scope.node_ids.includes(id);
  return <div className="goal-linked-node">
    <strong>{node.unlocked ? node.title : "未解锁知识点"}</strong>
    <span className="goal-muted">{progressLabel(node)}{node.review_verification && node.review_verification !== "none" ? " · 另有当前资料范围验收记录" : ""}</span>
    <div className="goal-actions">
      <Button size="sm" variant="outline" disabled={busy || outside} onClick={() => onNode(id, "node")}><Map />{node.unlocked ? "进入节点" : "临时直达"}</Button>
      <Button size="sm" variant="ghost" disabled={busy || outside} onClick={() => onNode(id, "chat")}><MessageCircle />学习对话</Button>
    </div>
    {outside && <p className="goal-muted">不在当前 PDF 复习范围，请先调整范围或退出复习。</p>}
  </div>;
}

export function GoalDetail({ course, goal, busy, onEdit, onUpdate, onNode }: {
  course: Course; goal: Goal; busy: boolean; onEdit: () => void;
  onUpdate: (fields: Partial<GoalFields>) => Promise<void>;
  onNode: (nodeId: string, destination: "node" | "chat") => void;
}) {
  const states = [["todo", "移到待开始"], ["doing", "移到进行中"], ["done", "确认目标已达成"]] as const;
  return <aside className="goal-detail" aria-label="目标详情">
    <div className="goal-detail-head"><h3>{goal.title}</h3><Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>编辑</Button></div>
    <span className="goal-muted">{goal.kind === "personal" ? "个人目标" : "课程目标"}</span>
    {goal.description && <p className="whitespace-pre-wrap">{goal.description}</p>}
    {readyToFinish(goal) && <p className="goal-ready" role="status">关联知识点都已验收通过，小目标也全部完成。核对后可以点「确认目标已达成」。</p>}
    <div className="goal-actions">
      <span className="t-meta">当前：{{ todo: "待开始", doing: "进行中", done: "已完成" }[goal.status]}</span>
      {states.filter(([status]) => status !== goal.status).map(([status, label]) => <Button key={status} size="sm" variant={status === "done" ? "default" : "outline"} disabled={busy} onClick={() => void onUpdate({ status })}>{label}</Button>)}
    </div>
    <section><h4>小目标 · {goal.progress?.subtasks_done || 0}/{goal.subtasks?.length || 0}</h4>
      {(goal.subtasks || []).map((task) => <label className="goal-check" key={task.id}>
        <input type="checkbox" checked={task.done || !!task.auto_done} disabled={busy || !!task.auto_done} onChange={(event) => void onUpdate({ subtasks: goal.subtasks.map((entry) => entry.id === task.id ? { ...entry, done: event.target.checked } : entry) })} />
        <span><span className={task.done || task.auto_done ? "line-through text-muted-foreground" : ""}>{task.title}</span>
          {task.node_id && <small className="block text-xs text-muted-foreground">
            {task.auto_done ? "· 关联知识点已验收，自动完成" : `· 关联：${course.nodes.find((node) => node.id === task.node_id)?.title || "知识点"}，验收通过后自动完成`}</small>}
        </span>
      </label>)}
      {!goal.subtasks?.length && <p className="goal-muted">编辑目标，拆成可以逐项完成的小目标。</p>}
    </section>
    <section><h4>关联知识点 · {goal.node_ids.length}</h4>
      {goal.node_ids.map((id) => <LinkedGoalNode key={id} course={course} id={id} busy={busy} onNode={onNode} />)}
      {!goal.node_ids.length && <p className="goal-muted">尚未关联知识点，可在编辑中添加。</p>}
    </section>
    {!!goal.sources?.length && <details><summary>材料依据（AI 建议，需核对）</summary>{goal.sources.map((source, index) => <p className="goal-source" key={index}>
      <a target="_blank" rel="noreferrer" href={materialFileUrl(course.id, source.material_id, source.page)}>{course.materials.find((material) => material.id === source.material_id)?.name} · 第 {source.page} 页</a>
      <span className="block whitespace-pre-wrap">{source.quote}</span>
    </p>)}</details>}
  </aside>;
}
