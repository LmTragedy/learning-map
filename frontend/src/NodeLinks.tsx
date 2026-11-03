import { useState } from "react";
import { ArrowUpRight, CornerDownRight, Sparkles } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { resolveBridges, type ResolvedBridge } from "./bridges";
import { TaskCards } from "./aiTasks";
import type { Course, LearningNode, Step } from "./types";
import "./nodeLinks.css";

type Edge = Course["edges"][number];
type Selected = { kind: "bridge"; item: ResolvedBridge; side: "in" | "out" } | { kind: "step"; step: Step; index: number } | { kind: "chain"; item: ResolvedBridge };

/** A link worth drawing: written (not the migrated placeholder) and not a "read after" extension. */
const strong = (item: ResolvedBridge) => !item.bridge.legacy && item.bridge.strength !== "extension";
const done = (node: LearningNode) => node.status === "passed" || node.status === "mastered";

/**
 * One node's links read row by row along its steps: what each step uses (left)
 * and what later nodes build on it (right). Clicking anything shows its plain and formal wording.
 */
export function NodeLinks({ course, node, busy, aiEnabled, act, canOpen, onNavigate, onOpenBridge }: {
  course: Course; node: LearningNode; busy: boolean; aiEnabled: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  canOpen: (node: LearningNode) => boolean;
  onNavigate: (node: LearningNode, edge?: Edge) => void;
  onOpenBridge: (edge: Edge) => void;
}) {
  const edges = course.edges.filter((edge) => !edge.synthesis_link && edge.kind !== "对比");
  const incoming = resolveBridges(course, edges.filter((edge) => edge.target === node.id));
  const outgoing = resolveBridges(course, edges.filter((edge) => edge.source === node.id));
  const steps = node.steps || [];
  const stepIds = new Set(steps.map((step) => step.id));
  const shownIn = incoming.filter(strong), shownOut = outgoing.filter(strong);
  const rows = steps.map((step, index) => ({
    step, index,
    uses: shownIn.filter((item) => item.bridge.to_step === step.id),
    usedBy: shownOut.filter((item) => item.bridge.from_step === step.id),
  }));
  const loose = { uses: shownIn.filter((item) => !stepIds.has(item.bridge.to_step)), usedBy: shownOut.filter((item) => !stepIds.has(item.bridge.from_step || "")) };
  const hidden = new Set([...incoming, ...outgoing].filter((item) => !strong(item)).map((item) => item.edge.id)).size;
  const shownTargets = new Set([node.id, ...shownOut.map((item) => item.target.id)]);
  // The next lesson after a later node, so the chain reads on ("逆向归纳 → 结果保证").
  const next = (item: ResolvedBridge) => resolveBridges(course, edges.filter((edge) => edge.source === item.target.id))
    .find((candidate) => strong(candidate) && candidate.bridge.strength === "required" && !shownTargets.has(candidate.target.id));
  const [selected, setSelected] = useState<Selected | null>(shownIn[0] ? { kind: "bridge", item: shownIn[0], side: "in" }
    : shownOut[0] ? { kind: "bridge", item: shownOut[0], side: "out" } : null);
  const empty = !shownIn.length && !shownOut.length;
  const find = () => void act("find-links", () => api.findLinks(course.id, node.id, course.revision));

  const isOn = (item: ResolvedBridge) => selected?.kind !== "step" && selected?.item.bridge.id === item.bridge.id;
  const chip = (item: ResolvedBridge, side: "in" | "out") => {
    const other = side === "in" ? item.source : item.target;
    const tag = side === "in" ? item.edge.kind === "帮助理解" ? "对比着看" : item.bridge.strength === "required" ? "必须" : "建议" : "";
    return <button key={item.bridge.id} type="button" className={cn("nl-chip", item.bridge.strength !== "required" && "is-weak", isOn(item) && "is-on")}
      aria-pressed={isOn(item)} onClick={() => setSelected({ kind: "bridge", item, side })}>
      <span className="nl-chip-title"><span className={cn("nl-dot", done(other) && "is-done")} aria-label={done(other) ? "已学会" : "还没学"} />{other.title}</span>
      {tag && <span className="nl-chip-tag">{tag}</span>}
    </button>;
  };
  const right = (items: ResolvedBridge[]) => items.map((item) => {
    const after = next(item);
    return <div key={item.bridge.id} className="nl-stack">
      {chip(item, "out")}
      {after && <div className="nl-next">
        <CornerDownRight size={13} aria-hidden />
        <button type="button" className={cn("nl-chip is-small", selected?.kind === "chain" && selected.item.bridge.id === after.bridge.id && "is-on")}
          onClick={() => setSelected({ kind: "chain", item: after })}>{after.target.title}</button>
      </div>}
    </div>;
  });
  const row = (key: string, uses: ResolvedBridge[], center: React.ReactNode, usedBy: ResolvedBridge[]) => <div key={key} className="nl-row">
    <div className="nl-side is-left"><span className="nl-side-label">先要会</span>{uses.map((item) => chip(item, "in"))}</div>
    <div className={cn("nl-link", !uses.length && "is-none", uses.length && uses.every((item) => item.bridge.strength !== "required") && "is-weak")} aria-hidden />
    {center}
    <div className={cn("nl-link", !usedBy.length && "is-none", usedBy.length && usedBy.every((item) => item.bridge.strength !== "required") && "is-weak")} aria-hidden />
    <div className="nl-side is-right"><span className="nl-side-label">后面用到</span>{right(usedBy)}</div>
  </div>;

  return <section className="node-links" aria-label="前后联系">
    <div className="nl-head">
      <h3 className="t-label">前后联系</h3>
      {aiEnabled && <Button size="sm" variant="ghost" disabled={busy} onClick={find}><Sparkles /> {empty ? "让 AI 找前后联系" : "让 AI 重新找"}</Button>}
    </div>
    <TaskCards kind="links" target={node.id} limit={1} />
    {(node.plain || node.formal) && <div className="nl-self">
      {node.plain && <p className="nl-plain">{node.plain}</p>}
      {node.formal && <p className="nl-formal">{node.formal}</p>}
    </div>}

    {empty ? <p className="nl-empty">
      {hidden ? `这一课有 ${hidden} 条联系，但还没写清具体用到哪一块。` : "这一课还没有整理出前后联系。"}
      {aiEnabled ? "点「让 AI 找前后联系」，AI 会按材料找出真正要先会的知识点，以及后面哪几课会用到它。" : "在设置中打开 AI 后可以自动整理。"}
    </p> : <>
      <div className="nl-grid">
        <div className="nl-row is-head" aria-hidden><span className="nl-side is-left">先要会</span><span /><span>这一课的每一步</span><span /><span className="nl-side is-right">后面用到它</span></div>
        {rows.map(({ step, index, uses, usedBy }) => row(step.id, uses, <button type="button"
          className={cn("nl-step", selected?.kind === "step" && selected.step.id === step.id && "is-on")}
          onClick={() => setSelected({ kind: "step", step, index })}><span className="nl-num">{index + 1}</span>{step.title}</button>, usedBy))}
        {(loose.uses.length > 0 || loose.usedBy.length > 0) && row("loose", loose.uses,
          <div className="nl-step is-loose">{steps.length ? "整体（没对到具体一步）" : "这一课整体"}</div>, loose.usedBy)}
      </div>
      <div className="nl-legend">
        <span><i className="is-strong" />直接用到</span><span><i className="is-weak" />建议 / 对比着看</span>
        {hidden > 0 && <span>另有 {hidden} 条较弱或还没写清的联系，见下方「知识桥」</span>}
      </div>
      {selected && <Detail selected={selected} canOpen={canOpen} onNavigate={onNavigate} onOpenBridge={onOpenBridge} />}
    </>}
  </section>;
}

function Detail({ selected, canOpen, onNavigate, onOpenBridge }: {
  selected: Selected; canOpen: (node: LearningNode) => boolean;
  onNavigate: (node: LearningNode, edge?: Edge) => void; onOpenBridge: (edge: Edge) => void;
}) {
  if (selected.kind === "step") {
    return <div className="nl-detail">
      <strong className="nl-detail-title">第 {selected.index + 1} 步 · {selected.step.title}</strong>
      <Words formal={selected.step.formal} />
    </div>;
  }
  const { item } = selected;
  const incoming = selected.kind === "bridge" && selected.side === "in";
  const other = selected.kind === "chain" ? item.target : incoming ? item.source : item.target;
  const ownStep = item.source.steps?.findIndex((step) => step.id === item.bridge.from_step) ?? -1;
  const line = selected.kind === "chain"
    ? `接在「${item.source.title}」后面：${item.bridge.how}`
    : incoming
      ? `${item.stepNumber ? `用在这一课第 ${item.stepNumber} 步` : "用在这一课"}${item.piece ? `，用到它的「${item.piece.title}」` : ""}：${item.bridge.how}`
      : `${ownStep >= 0 ? `建立在这一课第 ${ownStep + 1} 步上` : "建立在这一课上"}${item.step ? `，用于它的「${item.step.title}」` : ""}：${item.bridge.how}`;
  return <div className="nl-detail">
    <div className="flex items-start gap-2">
      <strong className="nl-detail-title min-w-0 flex-1">{other.title}</strong>
      {canOpen(other) && <Button size="sm" variant="ghost" onClick={() => onNavigate(other, item.edge)}>打开 <ArrowUpRight /></Button>}
    </div>
    <p className="nl-how">{line}</p>
    <Words plain={other.plain} formal={other.formal} />
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {item.bridge.origin !== "user" && <span className="t-meta">{item.bridge.sources?.length ? `AI 写的 · 有 ${item.bridge.sources.length} 处材料原文` : "AI 写的 · 材料里没找到原文依据"}</span>}
      <Button size="sm" variant="ghost" onClick={() => onOpenBridge(item.edge)}>看这条联系的详情</Button>
    </div>
  </div>;
}

function Words({ plain, formal }: { plain?: string; formal?: string }) {
  if (!plain && !formal) return <p className="t-meta mt-2">还没有大白话和正式说法；点上方「让 AI 重新找」会一起写好。</p>;
  return <>
    {plain && <><div className="nl-k">大白话</div><p>{plain}</p></>}
    {formal && <><div className="nl-k">正式说法</div><p className="nl-formal">{formal}</p></>}
  </>;
}
