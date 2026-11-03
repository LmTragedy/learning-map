import { useRef, useState } from "react";
import { BookOpen, Download, Maximize2, MessageCircle, Sparkles, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { api, lessonHtmlUrl } from "./api";
import type { Course, LearningNode, Lesson } from "./types";

type LessonProps = {
  course: Course; node: LearningNode; busy: boolean; aiEnabled: boolean;
  act: (key: string, action: () => Promise<Course>) => Promise<Course | undefined>;
  onDiscuss: (message: string) => void;
  onOpenLesson: (id: string) => void;
};

export function LessonPanel({ course, node, busy, aiEnabled, act, onDiscuss, onOpenLesson }: LessonProps) {
  const lessons = node.lessons ?? [];
  const [selectedId, setSelectedId] = useState(lessons.at(-1)?.id ?? "");
  const [focus, setFocus] = useState("");
  const pendingRequest = useRef<{ key: string; id: string }>();
  const lesson = lessons.find((entry) => entry.id === selectedId) ?? lessons.at(-1);
  const generate = async (kind: "initial" | "supplement") => {
    const key = `${kind}:${focus.trim()}`;
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: crypto.randomUUID() };
    const saved = await act("lesson", () => api.lesson(course.id, node.id, {
      kind, focus: focus.trim(), request_id: pendingRequest.current!.id,
    }));
    if (saved) {
      const generated = saved.nodes.find((entry) => entry.id === node.id)?.lessons?.at(-1);
      if (generated) {
        setSelectedId(generated.id);
        onOpenLesson(generated.id);
      }
      setFocus("");
      pendingRequest.current = undefined;
    }
  };
  return <div className="lesson-panel flex flex-col gap-3">
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary"><BookOpen size={17} /></span>
        <div className="min-w-0">
          <h3 className="t-item">{lesson ? "继续这一步" : "从一个小例子开始"}</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{lesson ? lesson.goal : "先理解一个小目标，再自己试一题。看不懂的地方，可以继续拆小、换例子。"}</p>
        </div>
      </div>
      {lesson ? <div className="mt-3 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">已保存的小课
          <select className="w-full" value={lesson.id} onChange={(event) => setSelectedId(event.target.value)}>
            {lessons.map((entry, index) => <option value={entry.id} key={entry.id}>
              {index + 1}. {entry.title}{entry.read_at ? " · 已读" : ""}
            </option>)}
          </select>
        </label>
        <Button className="w-full" onClick={() => onOpenLesson(lesson.id)}><Maximize2 /> 打开学习网页</Button>
        <p className="text-xs text-muted-foreground">{lesson.read_at ? "已记录阅读，可继续练习验收。" : "已保存，重新打开不会重复生成。"}</p>
      </div> : <Button className="mt-3 w-full" onClick={() => void generate("initial")} disabled={busy || !aiEnabled}>
        <Sparkles /> 生成小课
      </Button>}
    </div>
    {lesson && <>
      <form className="flex flex-col gap-2 rounded-xl border border-border p-3" onSubmit={(event) => { event.preventDefault(); void generate("supplement"); }}>
        <label className="text-[13px] font-medium" htmlFor="lesson-focus">哪里还不够清楚？</label>
        <textarea id="lesson-focus" className="w-full resize-y" value={focus} onChange={(event) => setFocus(event.target.value)} rows={2}
          maxLength={2000} placeholder="例如：把第二步展开，或者换一个更简单的例子…" disabled={!aiEnabled || busy} />
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" size="sm" className="flex-1" disabled={busy || !aiEnabled || !focus.trim()}><Sparkles /> 补一节小课</Button>
          <Button type="button" variant="ghost" size="sm" className="flex-1" onClick={() => onDiscuss(`关于小课「${lesson.title}」：`)}><MessageCircle /> 带着问题对话</Button>
        </div>
      </form>
    </>}
    <p className="text-xs text-muted-foreground">阅读和小课自测不会改变掌握状态；准备好后再做节点验收。</p>
  </div>;
}

export function LessonReader({ lesson, courseId, nodeId, busy, embedded, onClose, onRead, onPractice, onDiscuss }: {
  lesson: Lesson; courseId: string; nodeId: string; busy: boolean;
  /** Inside the workbench the tab already shows the title, close and download. */
  embedded?: boolean;
  onClose: () => void; onRead: () => void; onPractice: () => void;
  onDiscuss: () => void;
}) {
  const url = lessonHtmlUrl(courseId, nodeId, lesson.id);
  return <section className="lesson-reader" aria-label={`学习网页：${lesson.title}`}>
    {!embedded && <header><div><span className="eyebrow">小课</span><strong>{lesson.title}</strong></div>
      <a href={`${url}?download=true`} download title="下载 HTML 小课"><Download size={18} /><span>下载 HTML</span></a>
      <button className="icon-btn" onClick={onClose} title="关闭小课，返回地图" aria-label="关闭小课，返回地图"><X size={18} /></button></header>}
    <iframe key={lesson.id} src={url} title={lesson.title} sandbox="" referrerPolicy="no-referrer" />
    <footer><span>{lesson.read_at ? "已记录阅读 · 不等于验收通过" : "想好自测题，再查看参考思路"}</span>
      <button className="secondary" onClick={onRead} disabled={busy || Boolean(lesson.read_at)}>{lesson.read_at ? "已读" : "标记本节已读"}</button>
      <button className="secondary" onClick={onDiscuss}><MessageCircle size={16} /> 提问</button>
      <button className="primary" onClick={onPractice} disabled={busy}>去练习验收</button></footer>
  </section>;
}
