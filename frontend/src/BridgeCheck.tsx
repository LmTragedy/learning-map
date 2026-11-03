import { useState } from "react";
import { CircleHelp, FileText } from "lucide-react";
import { Button } from "./components/ui/button";
import { formatTime } from "./formatTime";
import { cn } from "./lib/utils";
import type { ResolvedBridge } from "./bridges";
import type { Source } from "./types";

const stateText = { known: "测过会", unsure: "不确定", missing: "练习中暴露缺口" } as const;

/**
 * The ten-second check on one earlier piece this node uses: what happens without it, the check
 * question with an answer box, "我会 / 不确定", and the original page to verify against.
 */
export function BridgeCheck({ item, busy, onCheck, onOpenSource }: {
  item: ResolvedBridge; busy: boolean;
  onCheck: (result: "known" | "unsure", answer: string) => void;
  onOpenSource: (source: Source) => void;
}) {
  const [answerShown, setAnswerShown] = useState(false);
  const [answer, setAnswer] = useState(item.bridge.state?.answer || "");
  const { bridge } = item;
  const state = bridge.state?.result;
  const evidence = bridge.sources[0] || item.piece?.sources?.[0];
  return <div className="mt-2 flex flex-col gap-1 text-[13px] leading-relaxed">
    {bridge.if_missing && <p><span className="text-muted-foreground">不会会 </span>{bridge.if_missing}</p>}
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
    {evidence && <div><Button size="sm" variant="ghost" onClick={() => onOpenSource(evidence)}><FileText /> 看原文 p.{evidence.page}</Button></div>}
  </div>;
}
