import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { Send, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import type { LearningNode } from "./types";

/** Follow-ups that fit almost any explanation; a click puts one in the draft, it is never sent on its own. */
const FOLLOW_UPS = ["举个反例", "换个说法再讲一遍", "出一道小题考我"];

/**
 * The node's learning chat as a full-height view of the right panel: messages scroll, the
 * composer stays at the bottom, and `context` says what the workbench is showing beside it.
 */
export function NodeChat({ node, busy, aiEnabled, message, fieldRef, context, onMessage, onSend, onSaveToNote }: {
  node: LearningNode; busy: boolean; aiEnabled: boolean; message: string;
  fieldRef: RefObject<HTMLTextAreaElement>;
  context?: ReactNode;
  onMessage: (text: string) => void;
  onSend: () => void;
  onSaveToNote: (text: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [node.chats.length]);
  const addFollowUp = (text: string) => {
    onMessage(message.trim() ? `${message.trimEnd()}\n${text}` : text);
    fieldRef.current?.focus();
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    {context && <div className="flex items-center gap-2 border-b border-border px-5 py-2.5 text-xs text-muted-foreground [&_b]:font-medium [&_b]:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">{context}</div>}
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4" aria-live="polite">
      {node.chats.length ? node.chats.map((chat) => chat.role === "assistant"
        ? <div key={chat.id} className="flex max-w-[95%] flex-col gap-1">
          <span className="text-xs text-muted-foreground">AI 导师</span>
          <p className="whitespace-pre-wrap text-sm leading-[1.75] text-foreground [overflow-wrap:anywhere]">{chat.content}</p>
          <button className="cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => onSaveToNote(chat.content)}>＋ 存入笔记</button>
        </div>
        : <p key={chat.id} className="max-w-[88%] self-end whitespace-pre-wrap rounded-xl rounded-br-sm bg-secondary px-3 py-2 text-sm leading-[1.7] [overflow-wrap:anywhere]">{chat.content}</p>,
      ) : <div className="m-auto flex max-w-[30ch] flex-col items-center gap-2 text-center text-sm text-muted-foreground">
        <Sparkles size={18} aria-hidden />
        <p>从你已有的理解出发，和 AI 一起梳理「{node.title}」。</p>
      </div>}
      <div ref={end} />
    </div>
    {aiEnabled && <div className="flex flex-wrap gap-1.5 px-5 pb-2.5">
      {FOLLOW_UPS.map((text) => <button key={text} onClick={() => addFollowUp(text)}
        className="cursor-pointer rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-input hover:text-foreground">{text}</button>)}
    </div>}
    <form className={cn("mx-3 mb-3 flex items-end gap-2 rounded-xl border border-input bg-field p-2 focus-within:border-zinc-500", !aiEnabled && "opacity-60")}
      onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      <textarea ref={fieldRef} className="min-h-[44px] min-w-0 flex-1 resize-none !border-0 !bg-transparent !p-1 text-sm !shadow-none outline-none" aria-label="学习对话" value={message} rows={2}
        placeholder={aiEnabled ? "说说你的想法或疑问…（Enter 发送）" : "AI 辅助已关闭，在设置中打开后可以对话"} disabled={!aiEnabled}
        onChange={(event) => onMessage(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSend(); } }} />
      <Button size="icon-sm" disabled={busy || !message.trim() || !aiEnabled} title="发送" aria-label="发送"><Send /></Button>
    </form>
  </div>;
}
