import { useState } from "react";
import { formatTime } from "./formatTime";
import { ArrowRight, CheckCircle2, CircleDashed, CircleHelp, FileText, Lock, Waypoints } from "lucide-react";
import { api } from "./api";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { nodeBridges, pieceLabel, stepLabel, STRENGTH_LABEL, type ResolvedBridge } from "./bridges";
import type { Course, LearningNode, Source, Strength } from "./types";

type Edge = Course["edges"][number];

const strengthVariant: Record<Strength, "passed" | "secondary" | "outline"> = { required: "passed", suggested: "secondary", extension: "outline" };
const stateText = { known: "测过会", unsure: "不确定", missing: "练习中暴露缺口" } as const;

/**
 * The node's knowledge bridges: which pieces of earlier nodes each of its steps uses (with a
 * ten-second check), and where this node is used later, so a link reads as "step 2 needs X's
 * transitivity" rather than a bare arrow.
 */
export function BridgeCard({ course, node, busy, canOpen, act, onNavigate, onOpenBridge, onOpenSource }: {
  course: Course; node: LearningNode; busy: boolean;
  canOpen: (node: LearningNode) => boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onNavigate: (node: LearningNode, edge?: Edge) => void;
  onOpenBridge: (edge: Edge) => void;
  onOpenSource: (source: Source) => void;
}) {
  const { incoming, outgoing, contrasts } = nodeBridges(course, node);
  if (!incoming.length && !outgoing.length && !contrasts.length) return null;
  const required = incoming.filter((item) => item.bridge.strength === "required");
  const known = required.filter((item) => item.bridge.state?.result === "known").length;
  const sourceCount = new Set(incoming.map((item) => item.source.id)).size;
  return <section aria-label="知识桥">
    {!!incoming.length && <>
      <h3 className="t-label flex items-center gap-1.5"><Waypoints size={14} aria-hidden /> 要用到</h3>
      <p className="t-meta mt-0.5">{sourceCount} 个知识点的 {incoming.length} 块内容{required.length ? ` · 必需的 ${required.length} 块里你已确认会 ${known} 块` : ""}</p>
      <div className="mt-2 flex flex-col gap-2">
        {incoming.map((item) => <IncomingBridge key={item.bridge.id} item={item} busy={busy} visible={canOpen(item.source)}
          onCheck={(result, answer) => void act("bridge-check", () => api.checkBridge(course.id, item.edge.id, item.bridge.id, result, answer))}
          onNavigate={() => onNavigate(item.source, item.edge)} onOpenBridge={() => onOpenBridge(item.edge)} onOpenSource={onOpenSource} />)}
      </div>
    </>}
    {!!outgoing.length && <>
      <h3 className={cn("t-label", incoming.length && "mt-4")}>学完会用在</h3>
      <div className="mt-2 flex flex-col gap-1.5">
        {outgoing.map((item) => {
          const open = canOpen(item.target);
          return <button key={item.bridge.id} disabled={!open} onClick={() => onNavigate(item.target, item.edge)}
            className="flex cursor-pointer flex-col gap-0.5 rounded-lg border border-border bg-st-mastered/5 px-3 py-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60">
            <span className="flex items-center gap-2">
              <strong className="t-item min-w-0 flex-1 truncate">{open ? item.target.title : "后续知识点（解锁后显示）"}</strong>
              <Badge variant={strengthVariant[item.bridge.strength]}>{STRENGTH_LABEL[item.bridge.strength]}</Badge>
            </span>
            {open && <span className="text-[13px] text-muted-foreground">用它的 <b className="font-medium text-foreground">{item.piece?.title || "内容"}</b>{item.step ? `，${stepLabel(item)}` : ""}</span>}
            {open && item.bridge.how && <span className="t-meta line-clamp-2">{item.bridge.how}</span>}
          </button>;
        })}
      </div>
    </>}
    {!!contrasts.length && <>
      <h3 className={cn("t-label", (incoming.length || outgoing.length) && "mt-4")}>容易混淆</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {contrasts.map((edge) => {
          const other = course.nodes.find((entry) => entry.id === (edge.source === node.id ? edge.target : edge.source));
          return other && <Button key={edge.id} size="sm" variant="outline" disabled={!canOpen(other)} onClick={() => onOpenBridge(edge)}>
            {node.title} ↔ {canOpen(other) ? other.title : "未解锁知识点"}
          </Button>;
        })}
      </div>
    </>}
  </section>;
}

function IncomingBridge({ item, busy, visible, onCheck, onNavigate, onOpenBridge, onOpenSource }: {
  item: ResolvedBridge; busy: boolean; visible: boolean;
  onCheck: (result: "known" | "unsure", answer: string) => void; onNavigate: () => void; onOpenBridge: () => void;
  onOpenSource: (source: Source) => void;
}) {
  const [answerShown, setAnswerShown] = useState(false);
  const [answer, setAnswer] = useState(item.bridge.state?.answer || "");
  const { bridge, source } = item;
  const state = bridge.state?.result;
  const done = source.status === "passed" || source.status === "mastered";
  const evidence = bridge.sources[0] || item.piece?.sources?.[0];
  const Icon = !visible ? Lock : state === "known" || (!state && done) ? CheckCircle2 : CircleDashed;
  return <div className={cn("rounded-lg border border-border px-3 py-2.5", (state === "missing" || state === "unsure") && "border-destructive/40 bg-destructive/5")}>
    <div className="flex items-start gap-2">
      <Icon size={15} className={cn("mt-0.5 shrink-0", state === "known" || (!state && done) ? "text-st-passed" : state ? "text-destructive" : "text-st-new")} aria-hidden />
      <strong className="t-item min-w-0 flex-1">{visible ? <>{source.title} · <span className="font-normal">{pieceLabel(item)}</span></> : "未解锁的先修知识点"}</strong>
      <Badge variant={strengthVariant[bridge.strength]}>{STRENGTH_LABEL[bridge.strength]}</Badge>
    </div>
    {visible && <div className="mt-1.5 flex flex-col gap-1 pl-[23px] text-[13px] leading-relaxed">
      {(item.step || bridge.how) && <p><span className="text-muted-foreground">用在 </span>{[stepLabel(item), bridge.how].filter(Boolean).join(" · ")}</p>}
      {bridge.if_missing && <p><span className="text-muted-foreground">不会会 </span>{bridge.if_missing}</p>}
      {bridge.legacy && <p className="t-meta">这条旧联系还没拆出具体用到哪一块。可以用页面顶部的「用 AI 补充知识桥」，或在详情里手动写。</p>}
      {state && <p className={cn("t-meta", state === "known" ? "text-st-passed" : "text-destructive")}>{stateText[state]} · {formatTime(bridge.state!.at, { date: true })}</p>}
      {bridge.check.question && <div className="mt-1 rounded-md border border-st-new/30 bg-st-new/5 px-2.5 py-2">
        <p className="flex items-start gap-1.5 font-medium"><CircleHelp size={14} className="mt-0.5 shrink-0 text-st-new" aria-hidden />检验：{bridge.check.question}</p>
        <textarea aria-label={`检验作答：${bridge.check.question}`} className="mt-2 w-full" rows={2} maxLength={2000} value={answer} placeholder="先写出你的答案，再自检" onChange={(event) => setAnswer(event.target.value)} />
        {answerShown && <p className="mt-1 text-muted-foreground">参考答案：{bridge.check.answer}</p>}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck("known", answer)}>我会</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck("unsure", answer)}>不确定</Button>
          <Button size="sm" variant="ghost" onClick={() => setAnswerShown((value) => !value)}>{answerShown ? "收起答案" : "看答案"}</Button>
        </div>
      </div>}
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button size="sm" variant="ghost" onClick={onNavigate}>去复习它 <ArrowRight /></Button>
        {evidence && <Button size="sm" variant="ghost" onClick={() => onOpenSource(evidence)}><FileText /> 看原文 p.{evidence.page}</Button>}
        <Button size="sm" variant="ghost" onClick={onOpenBridge}>桥详情</Button>
      </div>
    </div>}
  </div>;
}
