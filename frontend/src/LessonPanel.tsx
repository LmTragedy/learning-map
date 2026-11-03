import { useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, MessageCircle, Plus, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { api, lessonHtmlUrl } from "./api";
import type { Course, LearningNode } from "./types";

/**
 * The lesson mode of the study workbench: saved lessons as tabs, the selected one in full, and
 * one ask bar that either adds a lesson or sends the question to the chat beside it.
 */
export function LessonStudy({ course, node, lessonId, busy, aiEnabled, act, onSelect, onAsk, onPractice }: {
  course: Course; node: LearningNode; lessonId: string; busy: boolean; aiEnabled: boolean;
  act: (key: string, action: () => Promise<Course>) => Promise<Course | undefined>;
  onSelect: (id: string) => void;
  onAsk: (text: string) => void;
  onPractice: () => void;
}) {
  const lessons = node.lessons ?? [];
  const lesson = lessons.find((entry) => entry.id === lessonId) ?? lessons.at(-1);
  const [focus, setFocus] = useState("");
  const askField = useRef<HTMLTextAreaElement>(null);
  const pendingRequest = useRef<{ key: string; id: string }>();
  const ask = focus.trim();
  const generate = async (kind: "initial" | "supplement") => {
    const key = `${kind}:${ask}`;
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: crypto.randomUUID() };
    const saved = await act("lesson", () => api.lesson(course.id, node.id, {
      kind, focus: ask, request_id: pendingRequest.current!.id,
    }));
    if (saved) {
      const generated = saved.nodes.find((entry) => entry.id === node.id)?.lessons?.at(-1);
      if (generated) onSelect(generated.id);
      setFocus("");
      pendingRequest.current = undefined;
    }
  };

  if (!lesson) return <div className="lesson-study lesson-empty">
    <span className="grid size-11 place-items-center rounded-xl bg-secondary"><BookOpen size={20} aria-hidden /></span>
    <h2 className="t-section">从一个小例子开始</h2>
    <p>先看一个小例子理解「{node.title}」，再自己试一题。看不懂的地方可以继续拆小、换例子。</p>
    <Button onClick={() => void generate("initial")} disabled={busy || !aiEnabled}><Sparkles /> 生成小课</Button>
    {!aiEnabled && <p className="t-meta">AI 辅助已关闭，打开设置后可以生成小课。</p>}
  </div>;

  return <section className="lesson-study" aria-label={`小课：${lesson.title}`}>
    <div className="lesson-tabs" role="tablist" aria-label="已保存的小课">
      {lessons.map((entry, index) => <button key={entry.id} role="tab" aria-selected={entry.id === lesson.id}
        className="lesson-tab" title={entry.goal || entry.title} onClick={() => onSelect(entry.id)}>
        <span className="lesson-tab-n">{index + 1}</span><span className="truncate">{entry.title}</span>
        {entry.read_at && <Check size={13} className="shrink-0 text-st-passed" aria-label="已读" />}
      </button>)}
      <button className="lesson-tab lesson-tab-add" title="写下哪里不清楚，再补一节" onClick={() => askField.current?.focus()}>
        <Plus size={13} aria-hidden />补一节
      </button>
    </div>
    <iframe key={lesson.id} src={lessonHtmlUrl(course.id, node.id, lesson.id)} title={lesson.title} sandbox="" referrerPolicy="no-referrer" />
    <form className="lesson-dock" onSubmit={(event) => { event.preventDefault(); void generate("supplement"); }}>
      <textarea ref={askField} rows={1} maxLength={2000} value={focus} aria-label="哪里还不够清楚？"
        placeholder="哪里不清楚？比如：把第二步展开，或换一个更简单的例子" disabled={!aiEnabled || busy}
        onChange={(event) => setFocus(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onAsk(`关于小课「${lesson.title}」：${ask}`); setFocus(""); } }} />
      <Button type="submit" size="sm" variant="ghost" disabled={busy || !aiEnabled || !ask} title="按这个问题生成一节新的小课"><Sparkles /> 补一节</Button>
      <Button type="button" size="sm" variant="secondary" title="发到右侧的学习对话（Enter）"
        onClick={() => { onAsk(`关于小课「${lesson.title}」：${ask}`); setFocus(""); }}><MessageCircle /> 问 AI</Button>
      <span className="lesson-dock-sep" aria-hidden />
      {lesson.read_at
        ? <span className="lesson-read"><Check size={14} aria-hidden />已读</span>
        : <Button type="button" size="sm" variant="ghost" disabled={busy}
          onClick={() => void act("lesson-read", () => api.readLesson(course.id, node.id, lesson.id))}>标记已读</Button>}
      <Button type="button" size="sm" onClick={onPractice}
        title="阅读和小课自测不会改变掌握状态；准备好后再做节点验收。">去验收 <ArrowRight /></Button>
    </form>
  </section>;
}
