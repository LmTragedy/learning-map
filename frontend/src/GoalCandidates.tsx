import { useState } from "react";
import { Button } from "./components/ui/button";
import { SelectAll } from "./SelectAll";
import type { Course, GoalPreview } from "./types";
import { materialFileUrl } from "./api";
import { AiMark } from "./components/ui/ai-mark";

export function GoalCandidates({ course, preview, busy, onAccept, onCancel }: {
  course: Course; preview: GoalPreview; busy: boolean;
  onAccept: (indices: number[]) => Promise<void>; onCancel: () => void;
}) {
  const indices = preview.goals.map((_, index) => index);
  // Every candidate starts selected; the user unticks the ones to skip.
  const [checked, setChecked] = useState<number[]>(indices);
  return <section className="goal-candidates" aria-label="待确认的 AI 目标">
    <h3>核对材料目标</h3>
    <p className="goal-muted"><AiMark /> 勾选确认后才会加入看板。这一步分析了整门课程的材料。</p>
    {preview.revision !== course.revision && <p role="alert">课程已变化，此预览已失效，请取消后重新提取。</p>}
    {!preview.goals.length && <p>没有提取到材料支持的目标，可手动添加。</p>}
    {!!preview.goals.length && <SelectAll ids={indices} selected={checked} onChange={(next) => setChecked((next as number[]).sort((a, b) => a - b))} />}
    {preview.goals.map((goal, index) => <article className="goal-candidate" key={index}>
      <label className="goal-check"><input type="checkbox" checked={checked.includes(index)} onChange={(event) => setChecked(event.target.checked ? [...checked, index] : checked.filter((offset) => offset !== index))} /><strong>{goal.title}</strong></label>
      <p className="whitespace-pre-wrap">{goal.description}</p>
      {!!goal.subtasks.length && <ul>{goal.subtasks.map((title, offset) => <li key={offset}>{title}</li>)}</ul>}
      <details><summary>核对材料依据 · {goal.sources.length}</summary>{goal.sources.map((source, offset) => <p className="goal-source" key={offset}>
        <a target="_blank" rel="noreferrer" href={materialFileUrl(course.id, source.material_id, source.page)}>{course.materials.find((material) => material.id === source.material_id)?.name} · 第 {source.page} 页</a>
        <span className="block whitespace-pre-wrap">{source.quote}</span>
      </p>)}</details>
    </article>)}
    <div className="goal-actions"><Button variant="ghost" disabled={busy} onClick={onCancel}>取消预览</Button><Button disabled={busy || !checked.length || preview.revision !== course.revision} onClick={() => void onAccept(checked)}>确认加入所选目标（{checked.length}）</Button></div>
  </section>;
}
