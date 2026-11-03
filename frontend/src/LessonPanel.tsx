import { useEffect, useRef, useState } from "react";
import { BookOpen, Download, Maximize2, Sparkles, X } from "lucide-react";
import { api } from "./api";
import type { Course, LearningNode, Lesson } from "./types";

type LessonProps = {
  course: Course; node: LearningNode; busy: boolean; aiEnabled: boolean;
  act: (key: string, action: () => Promise<Course>) => Promise<Course | undefined>;
  onPractice: () => void; onDiscuss: (message: string) => void;
};

export function LessonPanel({ course, node, busy, aiEnabled, act, onPractice, onDiscuss }: LessonProps) {
  const lessons = node.lessons ?? [];
  const [selectedId, setSelectedId] = useState(lessons.at(-1)?.id ?? "");
  const [opened, setOpened] = useState(false);
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
      setSelectedId(saved.nodes.find((entry) => entry.id === node.id)?.lessons?.at(-1)?.id ?? "");
      setOpened(true);
      setFocus("");
      pendingRequest.current = undefined;
    }
  };
  return <div className="lesson-panel">
    <div className="lesson-intro"><BookOpen size={21} />
      <h3>{lesson ? "继续这一步" : "从一个小例子开始"}</h3>
      <p>{lesson ? lesson.goal : "先理解一个小目标，再自己试一题。看不懂的地方，可以继续拆小、换例子。"}</p></div>
    {lesson ? <>
      <label className="lesson-picker">已保存的小课
        <select value={lesson.id} onChange={(event) => setSelectedId(event.target.value)}>
          {lessons.map((entry, index) => <option value={entry.id} key={entry.id}>
            {index + 1}. {entry.title}{entry.read_at ? " · 已读" : ""}
          </option>)}
        </select>
      </label>
      <button className="primary lesson-open" onClick={() => setOpened(true)}><Maximize2 size={15} /> 打开学习网页</button>
      <p className="muted small">{lesson.read_at ? "已记录阅读，可继续练习验收。" : "已保存，重新打开不会重复生成。"}</p>
      <form className="lesson-supplement" onSubmit={(event) => { event.preventDefault(); void generate("supplement"); }}>
        <label htmlFor="lesson-focus">哪里还不够清楚？</label>
        <textarea id="lesson-focus" value={focus} onChange={(event) => setFocus(event.target.value)} rows={3}
          maxLength={2000} placeholder="例如：把第二步展开，或者换一个更简单的例子…" disabled={!aiEnabled || busy} />
        <button className="secondary" disabled={busy || !aiEnabled || !focus.trim()}>补一节小课</button>
      </form>
      <button className="secondary" onClick={() => onDiscuss(`关于小课「${lesson.title}」：`)}>带着问题继续对话</button>
    </> : <button className="primary lesson-open" onClick={() => void generate("initial")} disabled={busy || !aiEnabled}>
      <Sparkles size={15} /> 生成小课
    </button>}
    <p className="muted small">阅读和小课自测不会改变掌握状态；准备好后再做节点验收。</p>
    {opened && lesson && <LessonReader lesson={lesson} courseId={course.id} nodeId={node.id} busy={busy}
      onClose={() => setOpened(false)} onRead={() => void act("lesson-read", () => api.readLesson(course.id, node.id, lesson.id))}
      onPractice={() => { setOpened(false); onPractice(); }} />}
  </div>;
}

function LessonReader({ lesson, courseId, nodeId, busy, onClose, onRead, onPractice }: {
  lesson: Lesson; courseId: string; nodeId: string; busy: boolean;
  onClose: () => void; onRead: () => void; onPractice: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const url = `/api/courses/${courseId}/nodes/${nodeId}/lessons/${lesson.id}/html`;
  return <dialog ref={dialog} className="lesson-reader" aria-label={`学习网页：${lesson.title}`} onCancel={onClose}>
    <header><div><span className="eyebrow">小课</span><strong>{lesson.title}</strong></div>
      <a href={`${url}?download=true`} download title="下载 HTML 小课"><Download size={18} /><span>下载 HTML</span></a>
      <button className="icon-btn" onClick={onClose} title="关闭学习网页"><X size={18} /></button></header>
    <iframe key={lesson.id} src={url} title={lesson.title} sandbox="" referrerPolicy="no-referrer" />
    <footer><span>{lesson.read_at ? "已记录阅读 · 不等于验收通过" : "想好自测题，再查看参考思路"}</span>
      <button className="secondary" onClick={onRead} disabled={busy || Boolean(lesson.read_at)}>{lesson.read_at ? "已读" : "标记本节已读"}</button>
      <button className="primary" onClick={onPractice} disabled={busy}>去练习验收</button></footer>
  </dialog>;
}
