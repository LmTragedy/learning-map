import { useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, Plus, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { api, lessonHtmlUrl } from "./api";
import type { Course, LearningNode } from "./types";
import { TaskCards, useCourseTasks } from './aiTasks';
import { taskTime } from './aiTaskModel';
import './lessonLayout.css';

/**
 * The lesson mode of the study workbench: saved lessons as tabs and the selected one in full.
 * Questions go to the chat beside it (the one place to type); "补一节" opens a small form under its tab.
 */
export function LessonStudy({ course, node, lessonId, busy, aiEnabled, act, onSelect, onPractice }: {
  course: Course; node: LearningNode; lessonId: string; busy: boolean; aiEnabled: boolean;
  act: (key: string, action: () => Promise<Course>) => Promise<Course | undefined>;
  onSelect: (id: string) => void;
  onPractice: () => void;
}) {
  const lessons = node.lessons ?? [];
  const lesson = lessons.find((entry) => entry.id === lessonId) ?? lessons.at(-1);
  const [focus, setFocus] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const pendingRequest = useRef<{ key: string; id: string }>();
  const ledger = useCourseTasks();
  const pending = ledger.tasks.filter(t=>t.kind==='lesson'&&t.target===node.id&&(t.state!=='applied'||Date.parse(t.updated_at)>=ledger.openedAt&&ledger.clock-Date.parse(t.updated_at)<4000));
  const ask = focus.trim();
  const gaps = node.lesson_gaps ?? [];
  const generate = async (kind: "initial" | "supplement", focusText = ask) => {
    const key = `${kind}:${focusText}`;
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: crypto.randomUUID() };
    const saved = await act("lesson", () => api.lesson(course.id, node.id, {
      kind, focus: focusText, request_id: pendingRequest.current!.id,
    }));
    if (saved) {
      const generated = saved.nodes.find((entry) => entry.id === node.id)?.lessons?.at(-1);
      if (generated) onSelect(generated.id);
      setFocus("");
      setAddOpen(false);
      pendingRequest.current = undefined;
    }
  };

  if (!lesson) return <div className="lesson-study lesson-empty">
    <span className="grid size-11 place-items-center rounded-xl bg-secondary"><BookOpen size={20} aria-hidden /></span>
    <h2 className="t-section">从一个小例子开始</h2>
    <p>先看一个小例子理解「{node.title}」，再自己试一题。看不懂的地方可以继续拆小、换例子。</p>
    {pending.length
      ? <TaskCards kind="lesson" target={node.id} />
      : <Button onClick={() => void generate("initial")} disabled={busy || !aiEnabled}><Sparkles /> 生成小课</Button>}
    {!aiEnabled && <p className="t-meta">AI 辅助已关闭，打开设置后可以生成小课。</p>}
    {!!pending.length && <p className="t-meta">也可以在右上角「AI 任务」里查看全部记录。</p>}
  </div>;

  return <section className="lesson-study" aria-label={`小课：${lesson.title}`}>
    <div className="lesson-tabs" role="tablist" aria-label="已保存的小课">
      {lessons.map((entry, index) => <button key={entry.id} role="tab" aria-selected={entry.id === lesson.id}
        className="lesson-tab" title={`${entry.goal || entry.title}${entry.request_id ? `\n由 AI 任务写入 · ${taskTime(entry.created_at)}` : ''}`} onClick={() => onSelect(entry.id)}>
        <span className="lesson-tab-n">{index + 1}</span><span className="truncate">{entry.title}</span>
        {entry.read_at && <Check size={13} className="shrink-0 text-st-passed" aria-label="已读" />}
      </button>)}
      <Popover open={addOpen} onOpenChange={setAddOpen}>
        <PopoverTrigger asChild>
          <button className="lesson-tab lesson-tab-add" title="写下哪里不清楚，生成一节补充小课" aria-expanded={addOpen}>
            <Plus size={13} aria-hidden />补一节
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-[360px] flex-col gap-2.5">
          <form className="flex flex-col gap-2.5" onSubmit={(event) => { event.preventDefault(); if (ask) void generate("supplement"); }}>
            <label htmlFor="lesson-add-focus" className="text-sm font-semibold">这一节想补什么？</label>
            <textarea id="lesson-add-focus" rows={3} maxLength={2000} value={focus} autoFocus disabled={!aiEnabled || busy}
              placeholder="比如：把第二步展开，或换一个更简单的例子" className="resize-none text-[13px]"
              onChange={(event) => setFocus(event.target.value)} />
            <div className="flex flex-wrap gap-1.5">
              {[...gaps.map((gap) => `只讲：${gap}`), "把第二步展开", "换一个更简单的例子"].map((idea) =>
                <button type="button" key={idea} className="cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setFocus(idea)}>{idea}</button>)}
            </div>
            {!aiEnabled && <p className="t-meta">AI 辅助已关闭，打开设置后可以生成小课。</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setAddOpen(false)}>取消</Button>
              <Button type="submit" size="sm" disabled={busy || !aiEnabled || !ask || pending.length > 0}><Sparkles /> 生成补充小课</Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </div>
    {!!pending.length && <div className="lesson-thinking"><TaskCards kind="lesson" target={node.id} /></div>}
    {gaps.length > 0 && !pending.length && <div className="lesson-gaps" role="note">
      <span>{lessons.length === 1 ? "这节课写于地图更新之前，" : "已有的小课"}少讲了 {gaps.length} 个要点：<b>{gaps.join("、")}</b></span>
      <Button size="sm" variant="outline" disabled={busy || !aiEnabled}
        onClick={() => void generate("supplement", `逐个讲清楚这些还没讲到的知识块：${gaps.join("、")}。每块给出中文和英文术语、意思、条件和一个具体例子。`)}>
        <Sparkles /> {gaps.length === 1 ? "只补这一点" : `补这 ${gaps.length} 点`}
      </Button>
    </div>}
    <div className="lesson-visual-layout">
      <div className="lesson-frame-area">
        {/* Source links in the lesson open the original page in a new tab; scripts stay blocked.
            Same origin without scripts only lets the workbench read selected text for the note. */}
        <iframe key={lesson.id} src={lessonHtmlUrl(course.id, node.id, lesson.id)} title={lesson.title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
      </div>
    </div>
    {/* Questions go to the chat on the right; this bar only finishes the lesson. */}
    <div className="lesson-dock lesson-dock-end">
      <Button type="button" size="sm" variant="ghost" disabled={busy} aria-pressed={!!lesson.read_at}
        title={lesson.read_at ? "取消已读，恢复为未读" : "标记这节小课为已读"}
        onClick={() => void act("lesson-read", () => lesson.read_at
          ? api.unreadLesson(course.id, node.id, lesson.id)
          : api.readLesson(course.id, node.id, lesson.id))}>
        {lesson.read_at && <Check size={14} aria-hidden />}{lesson.read_at ? "已读 · 取消" : "标记已读"}
      </Button>
      <Button type="button" size="sm" onClick={onPractice}
        title="阅读和小课自测不会改变掌握状态；准备好后再做节点验收。">去验收 <ArrowRight /></Button>
    </div>
  </section>;
}
