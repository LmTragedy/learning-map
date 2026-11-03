import { useState } from "react";
import { ArrowLeft, TriangleAlert } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { nodeBridges, pieceLabel, type ResolvedBridge } from "./bridges";
import type { Attempt, Course, LearningNode } from "./types";

/**
 * After a practice that did not pass: the incoming bridges the grader blamed (or, when it named
 * none, the required ones not yet confirmed), each with its check question and a way back.
 */
export function BridgeGaps({ course, node, attempt, busy, act, onNavigate }: {
  course: Course; node: LearningNode; attempt: Attempt; busy: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  onNavigate: (node: LearningNode, edge?: Course["edges"][number]) => void;
}) {
  const { incoming } = nodeBridges(course, node);
  const blamed = incoming.filter((item) => attempt.judgment.missing_bridges?.includes(item.bridge.id));
  const unconfirmed = incoming.filter((item) => item.bridge.strength === "required" && item.bridge.state?.result !== "known");
  const shown = blamed.length ? blamed : unconfirmed;
  if (!shown.length) return null;
  return <div className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
    <strong className="flex items-center gap-1.5 text-[13px]"><TriangleAlert size={14} className="text-destructive" aria-hidden />
      {blamed.length ? "可能缺前面的这几块" : "先确认这几块必需的前置内容"}</strong>
    <p className="t-meta mt-0.5">{blamed.length ? "判卷时对照了进站的知识桥。" : "判卷没有指出具体缺哪一块；这些必需的桥你还没确认会。"}补完点「返回原复习目标」回到这道题。</p>
    <div className="mt-2 flex flex-col gap-2">
      {shown.map((item) => <Gap key={item.bridge.id} item={item} busy={busy}
        onCheck={(result) => void act("bridge-check", () => api.checkBridge(course.id, item.edge.id, item.bridge.id, result))}
        onBack={() => onNavigate(item.source, item.edge)} />)}
    </div>
  </div>;
}

function Gap({ item, busy, onCheck, onBack }: { item: ResolvedBridge; busy: boolean; onCheck: (result: "known" | "unsure") => void; onBack: () => void }) {
  const [answer, setAnswer] = useState(false);
  return <div className="rounded-lg border border-border bg-background px-3 py-2 text-[13px]">
    <strong className="font-medium">{item.source.title} · {pieceLabel(item)}</strong>
    {item.bridge.how && <p className="t-meta">{item.bridge.how}</p>}
    {item.bridge.check.question && <p className="mt-1">检验：{item.bridge.check.question}{answer && <span className="block text-muted-foreground">参考答案：{item.bridge.check.answer}</span>}</p>}
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      <Button size="sm" onClick={onBack}><ArrowLeft /> 回上一站补这一块</Button>
      {item.bridge.check.question && <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck("known")}>我会</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck("unsure")}>不确定</Button>
        <Button size="sm" variant="ghost" onClick={() => setAnswer((value) => !value)}>{answer ? "收起答案" : "看答案"}</Button>
      </>}
    </div>
  </div>;
}
