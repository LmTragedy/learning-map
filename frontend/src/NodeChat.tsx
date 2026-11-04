import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Send, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { ChatMarkdown } from "./ChatMarkdown";
import { TaskCards, useCourseTasks } from './aiTasks';
import { ACTIVE_STATES, taskTime } from './aiTaskModel';
import type { AiTask } from './aiTaskModel';
import type { LearningNode } from "./types";

/** Follow-ups that fit almost any explanation; a click puts one in the draft, it is never sent on its own. */
const FOLLOW_UPS = ["举个反例", "换个说法再讲一遍", "出一道小题考我"];

/**
 * The node's learning chat as a full-height view of the right panel: messages scroll, the
 * composer stays at the bottom, and `context` says what the workbench is showing beside it.
 */
export function NodeChat({ node, busy, aiEnabled, message, fieldRef, context, placeholder, onMessage, onSend, onSaveToNote, onSupplement }: {
  node: LearningNode; busy: boolean; aiEnabled: boolean; message: string;
  fieldRef: RefObject<HTMLTextAreaElement>;
  context?: ReactNode;
  placeholder?: string;
  onMessage: (text: string) => void;
  onSend: () => void;
  onSaveToNote: (text: string) => void;
  /** Set while a lesson is open: turns an answer that still did not land into a supplementary lesson. */
  onSupplement?: (question: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const ledger=useCourseTasks();
  // The message just sent stays visible above the thinking bubble until the reply is saved.
  const [sent, setSent] = useState("");
  const [confirmNewConversation,setConfirmNewConversation]=useState(false), [resettingConversation,setResettingConversation]=useState(false), [resetError,setResetError]=useState('');
  // A regenerated message stays only while its replacement is still unfinished; once that reply is saved it is in node.chats.
  const replacementOpen=(t:AiTask)=>ledger.tasks.some(next=>next.request_id===t.superseded_by&&next.state!=='applied'&&next.state!=='superseded');
  const pending=ledger.tasks.filter(t=>!t.history_only&&t.kind!=='history'&&t.kind==='chat'&&t.target===node.id&&t.state!=='applied'&&(t.state!=='superseded'||(!!t.superseded_by&&replacementOpen(t))))
    .sort((left,right)=>left.created_at.localeCompare(right.created_at));
  const thinking=pending.length;
  const blocking=pending.some(t=>['prepared','sending','running','processing'].includes(t.state));
  const streamed=pending.reduce((sum,t)=>sum+(t.partial_reply?.length||0),0);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [node.chats.length, thinking, streamed]);
  const send = () => {
    if (busy || pending.length || resettingConversation || !message.trim() || !aiEnabled) return;
    setSent(message.trim());
    onSend();
  };
  const addFollowUp = (text: string) => {
    onMessage(message.trim() ? `${message.trimEnd()}\n${text}` : text);
    fieldRef.current?.focus();
  };
  const resetConversation = async () => {
    if (busy || blocking || resettingConversation) return;
    setResettingConversation(true);
    setResetError('');
    try {
      await ledger.newConversation(node.id);
      setConfirmNewConversation(false);
    } catch (error) {
      setResetError(error instanceof Error ? error.message : '无法新建会话。');
    } finally {
      setResettingConversation(false);
    }
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-2.5">
      {context && <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground [&_b]:font-medium [&_b]:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">{context}</div>}
      <Button size="sm" variant="ghost" disabled={busy || blocking || resettingConversation} onClick={() => { setResetError(''); setConfirmNewConversation(true); }}>新会话</Button>
    </div>
    {confirmNewConversation && <div className="mx-5 mt-2 rounded-lg border border-border bg-card p-3 text-sm" role="group" aria-label="确认新建学习会话">
      <p className="text-muted-foreground">仅重置此节点当前资料范围的 Codex 主学习会话。已保存聊天原文和输入内容会保留；不会向 AI 发送内容。</p>
      {resetError && <p className="mt-2 text-destructive" role="alert">{resetError}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={resettingConversation} onClick={() => setConfirmNewConversation(false)}>取消</Button>
        <Button size="sm" disabled={resettingConversation || busy || blocking} onClick={() => void resetConversation()}>{resettingConversation ? '正在新建…' : '确认新会话'}</Button>
      </div>
    </div>}
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4" aria-live="polite">
      {node.chats.length ? node.chats.map((chat, index) => chat.role === "assistant"
        ? <div key={chat.id} className="flex max-w-[95%] flex-col gap-1">
          <span className="text-xs text-muted-foreground">AI 导师</span>
          <ChatMarkdown text={chat.content} />
          <div className="flex gap-3">
            <button className="cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => onSaveToNote(chat.content)}>＋ 存入笔记</button>
            {onSupplement && <button className="cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground" disabled={busy || !aiEnabled}
              onClick={() => onSupplement(node.chats.slice(0, index).reverse().find((entry) => entry.role === "user")?.content || chat.content.slice(0, 300))}>＋ 按这个补一节</button>}
          </div>
        </div>
        : <p key={chat.id} className="max-w-[88%] self-end whitespace-pre-wrap rounded-xl rounded-br-sm bg-secondary px-3 py-2 text-sm leading-[1.7] [overflow-wrap:anywhere]">{chat.content}</p>,
      ) : !thinking && <div className="m-auto flex max-w-[30ch] flex-col items-center gap-2 text-center text-sm text-muted-foreground">
        <Sparkles size={18} aria-hidden />
        <p>从你已有的理解出发，和 AI 一起梳理「{node.title}」。</p>
      </div>}
      {pending.map(task=><div key={task.id} className="flex flex-col gap-4">
        <p className="max-w-[88%] self-end whitespace-pre-wrap rounded-xl rounded-br-sm bg-secondary px-3 py-2 text-sm leading-[1.7] opacity-70 [overflow-wrap:anywhere]">{String(task.inputs?.message||sent||'原始输入暂不可读')}</p>
        {task.inputs?.message!==sent&&<span className="self-end text-[13px] text-muted-foreground">刷新前发出 · {taskTime(task.created_at)}</span>}
        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-muted-foreground">AI 导师</span>
          {/* Text streamed so far; the saved reply replaces it once the turn completes. */}
          {task.partial_reply && ACTIVE_STATES.has(task.state) && <ChatMarkdown text={task.partial_reply} />}
          <TaskCards kind="chat" target={node.id} taskId={task.id} limit={1} />
        </div>
      </div>)}
      <div ref={end} />
    </div>
    {aiEnabled && <div className="flex flex-wrap gap-1.5 px-5 pb-2.5">
      {FOLLOW_UPS.map((text) => <button key={text} onClick={() => addFollowUp(text)}
        className="cursor-pointer rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-input hover:text-foreground">{text}</button>)}
    </div>}
    <form className={cn("mx-3 mb-3 flex items-end gap-2 rounded-xl border border-input bg-field p-2 focus-within:border-zinc-500", !aiEnabled && "opacity-60")}
      onSubmit={(event) => { event.preventDefault(); send(); }}>
      <textarea ref={fieldRef} className="min-h-[44px] min-w-0 flex-1 resize-none !border-0 !bg-transparent !p-1 text-sm !shadow-none outline-none" aria-label="学习对话" value={message} rows={2}
        placeholder={aiEnabled ? placeholder || "说说你的想法或疑问…（Enter 发送）" : "AI 辅助已关闭，在设置中打开后可以对话"} disabled={!aiEnabled}
        onChange={(event) => onMessage(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />
      <Button size="icon-sm" disabled={busy || pending.length>0 || resettingConversation || !message.trim() || !aiEnabled} aria-label="发送" aria-describedby={pending.length ? "chat-send-why" : undefined}><Send /></Button>
    </form>
    {/* A disabled button cannot show a tooltip, so the reason is written out. */}
    {pending.length > 0 && <p id="chat-send-why" className="-mt-1.5 mx-4 mb-2 text-xs text-muted-foreground">{blocking ? '上一条还在等 AI 回复，回复后可以继续发送。' : '请先处理上方的上一条任务。'}</p>}
  </div>;
}
