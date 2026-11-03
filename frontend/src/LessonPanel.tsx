import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, Check, MessageCircle, Plus, Sparkles } from "lucide-react";
import { Button } from "./components/ui/button";
import { api, lessonHtmlUrl } from "./api";
import type { Course, LearningNode } from "./types";
import { TaskCards, useCourseTasks } from './aiTasks';
import { taskTime } from './aiTaskModel';
import { VisualRail } from './workbench/VisualRail';
import { VisualFocus } from './workbench/VisualFocus';
import type { MaterialView } from './workbench/useWorkbenchState';
import { validateVisualForCourse } from './workbench/diagramModel';

function parseProcessPages(value:string,availablePages:Set<number>):{ok:true;pages:number[]}|{ok:false;error:string}{
  const tokens=value.trim().split(/\s*(?:,|，)\s*|\s+/);
  if(tokens.length<2||tokens.length>20)return {ok:false,error:'请输入 2–20 个页码。'};
  if(tokens.some(token=>!/^\d+$/.test(token)))return {ok:false,error:'页码需为不重复的正整数，以逗号或空格分隔。'};
  const pages=tokens.map(Number);
  if(pages.some(page=>!Number.isSafeInteger(page)||page<1)||new Set(pages).size!==pages.length)return {ok:false,error:'页码需为不重复的正整数，以逗号或空格分隔。'};
  if(pages.some(page=>!availablePages.has(page)))return {ok:false,error:'所选材料中不存在这些页码。'};
  return {ok:true,pages};
}

function courseVisuals(input:unknown,course:Course){
  if(input===undefined)return {items:[],error:''};
  if(!Array.isArray(input)||input.length>40)return {items:[],error:'例图列表无法显示：格式不正确或超过 40 项。'};
  const seenIds=new Set<string>(), seenNumbers=new Set<number>();
  const items=input.map(visual=>validateVisualForCourse(visual,course.id,course.materials)).filter(visual=>{
    if(!visual||seenIds.has(visual.id)||seenNumbers.has(visual.number))return false;
    seenIds.add(visual.id);seenNumbers.add(visual.number);return true;
  }).filter(visual=>visual!==null);
  const error=items.length<input.length?'部分例图数据无法显示，请核对当前课程中的来源和页码。':'';
  return {items,error};
}

/**
 * The lesson mode of the study workbench: saved lessons as tabs, the selected one in full, and
 * one ask bar that either adds a lesson or sends the question to the chat beside it.
 */
export function LessonStudy({ course, node, lessonId, busy, aiEnabled, act, onSelect, onAsk, onPractice, onMaterial, onExcerpt }: {
  course: Course; node: LearningNode; lessonId: string; busy: boolean; aiEnabled: boolean;
  act: (key: string, action: () => Promise<Course>) => Promise<Course | undefined>;
  onSelect: (id: string) => void;
  onAsk: (text: string) => void;
  onPractice: () => void;
  onMaterial: (view:MaterialView)=>void; onExcerpt:(text:string)=>void;
}) {
  const lessons = node.lessons ?? [];
  const lesson = lessons.find((entry) => entry.id === lessonId) ?? lessons.at(-1);
  const [focus, setFocus] = useState("");
  const askField = useRef<HTMLTextAreaElement>(null);
  const pendingRequest = useRef<{ key: string; id: string }>();
  const ledger = useCourseTasks();
  const pending = ledger.tasks.filter(t=>t.kind==='lesson'&&t.target===node.id&&(t.state!=='applied'||Date.parse(t.updated_at)>=ledger.openedAt&&ledger.clock-Date.parse(t.updated_at)<4000));
  const [visualId,setVisualId] = useState('');
  const [visualRecoveryError,setVisualRecoveryError] = useState('');
  const [recoveringVisuals,setRecoveringVisuals] = useState(false);
  const [processFormOpen,setProcessFormOpen] = useState(false);
  const [processTitle,setProcessTitle] = useState('原页逐步对照');
  const [processMaterialId,setProcessMaterialId] = useState('');
  const [processPages,setProcessPages] = useState('');
  const [processError,setProcessError] = useState('');
  const [recoveringProcess,setRecoveringProcess] = useState(false);
  const visualTrigger = useRef<HTMLElement>();
  const {items:visuals,error:visualError}=courseVisuals(lesson?.visuals,course);
  const sourceMaterials=course.materials.filter(material=>material.kind==='pdf'||material.kind==='image');
  const processMaterial=sourceMaterials.find(material=>material.id===processMaterialId);
  const visual=visuals.find(v=>v.id===visualId);
  const closeVisual=()=>{setVisualId('');requestAnimationFrame(()=>visualTrigger.current?.focus());};
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
  const recoverVisuals = async () => {
    if(!lesson)return;
    setVisualRecoveryError('');
    setRecoveringVisuals(true);
    try{
      const recovered=await act('lesson-visuals',()=>api.recoverLessonVisuals(course.id,node.id,lesson.id,course.revision));
      if(!recovered)return;
      const saved=recovered?.nodes.find(entry=>entry.id===node.id)?.lessons?.find(entry=>entry.id===lesson.id)?.visuals;
      if(!saved?.length)setVisualRecoveryError('没有找到可接入的已存原文或原图。');
    }catch(error){setVisualRecoveryError(error instanceof Error?error.message:'接入已有来源失败。');}
    finally{setRecoveringVisuals(false);}
  };
  const recoverSourceProcess = async (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProcessError('');
    const title=processTitle.trim();
    if(!title||title.length>180){setProcessError('标题需为 1–180 个字符。');return;}
    if(!lesson||!processMaterial){setProcessError('请选择一份课程中的 PDF 或图片材料。');return;}
    const parsed=parseProcessPages(processPages,new Set(processMaterial.pages.map(page=>page.number)));
    if(!parsed.ok){setProcessError(parsed.error);return;}
    setRecoveringProcess(true);
    try{
      const recovered=await act('lesson-visuals',()=>api.recoverLessonVisuals(course.id,node.id,lesson.id,course.revision,[{title,material_id:processMaterial.id,pages:parsed.pages}]));
      if(recovered){setProcessFormOpen(false);setProcessError('');setProcessPages('');}
    }finally{setRecoveringProcess(false);}
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
        className="lesson-tab" title={`${entry.goal || entry.title}${entry.request_id ? `\n由 AI 任务写入 · ${taskTime(entry.created_at)}` : ''}`} onClick={() => {onSelect(entry.id);setVisualId('');setProcessFormOpen(false);setProcessError('');}}>
        <span className="lesson-tab-n">{index + 1}</span><span className="truncate">{entry.title}</span>
        {entry.read_at && <Check size={13} className="shrink-0 text-st-passed" aria-label="已读" />}
      </button>)}
      <button className="lesson-tab lesson-tab-add" title="写下哪里不清楚，再补一节" onClick={() => askField.current?.focus()}>
        <Plus size={13} aria-hidden />补一节
      </button>
    </div>
    {!!pending.length && <div className="lesson-thinking"><TaskCards kind="lesson" target={node.id} /></div>}
    {!lesson.visuals?.length&&<div className="lesson-visual-recovery"><Button size="sm" variant="outline" disabled={busy||recoveringVisuals} onClick={()=>void recoverVisuals()}>{recoveringVisuals?'正在查找已存来源…':'接入已有原文和原图'}</Button>{visualRecoveryError&&<span role="status">{visualRecoveryError}</span>}</div>}
    <div className="lesson-visual-recovery"><Button size="sm" variant="outline" disabled={busy||recoveringProcess} onClick={()=>{setProcessFormOpen(open=>!open);setProcessError('');}}>{processFormOpen?'取消接入原页过程':'接入原页过程'}</Button></div>
    {processFormOpen&&<form className="flex flex-wrap items-end gap-2 px-4 py-2" onSubmit={event=>void recoverSourceProcess(event)}>
      <label className="field-label">材料<select value={processMaterialId} onChange={event=>setProcessMaterialId(event.target.value)} required><option value="">选择课程材料</option>{sourceMaterials.map(material=><option key={material.id} value={material.id}>{material.name}</option>)}</select></label>
      <label className="field-label">页码（2–20 页）<input type="text" value={processPages} onChange={event=>setProcessPages(event.target.value)} placeholder="22, 24, 25" required /></label>
      <label className="field-label">标题<input type="text" value={processTitle} onChange={event=>setProcessTitle(event.target.value)} maxLength={180} required /></label>
      <Button type="submit" size="sm" disabled={busy||recoveringProcess||!sourceMaterials.length}>{recoveringProcess?'正在接入…':'接入原页过程'}</Button>
      {!sourceMaterials.length&&<span role="status">课程中没有可用的 PDF 或图片材料。</span>}
      {processError&&<span role="alert">{processError}</span>}
    </form>}
    {visualError&&<p className="visual-invalid-notice" role="alert">{visualError}</p>}
    <div className="lesson-visual-layout">
      <div className="lesson-frame-area">
        <iframe key={lesson.id} src={lessonHtmlUrl(course.id, node.id, lesson.id)} title={lesson.title} sandbox="" referrerPolicy="no-referrer" />
        {visual&&<VisualFocus key={visual.id} item={visual} onClose={closeVisual} onMaterial={onMaterial} onAsk={onAsk} onExcerpt={onExcerpt} />}
      </div>
      <VisualRail items={visuals} activeId={visualId} onSelect={(id,trigger)=>{visualTrigger.current=trigger;setVisualId(current=>current===id?'':id);}} />
    </div>
    <form className="lesson-dock" onSubmit={(event) => { event.preventDefault(); void generate("supplement"); }}>
      <textarea ref={askField} rows={1} maxLength={2000} value={focus} aria-label="哪里还不够清楚？"
        placeholder="哪里不清楚？比如：把第二步展开，或换一个更简单的例子" disabled={!aiEnabled || busy}
        onChange={(event) => setFocus(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onAsk(`关于小课「${lesson.title}」：${ask}`); setFocus(""); } }} />
      <Button type="submit" size="sm" variant="ghost" disabled={busy || !aiEnabled || !ask || pending.length>0} title="按这个问题生成一节新的小课"><Sparkles /> 补一节</Button>
      <Button type="button" size="sm" title="发到右侧的学习对话（Enter）"
        onClick={() => { onAsk(`关于小课「${lesson.title}」：${ask}`); setFocus(""); }}><MessageCircle /> 问 AI</Button>
      <span className="lesson-dock-sep" aria-hidden />
      <Button type="button" size="sm" variant="ghost" disabled={busy} aria-pressed={!!lesson.read_at}
        title={lesson.read_at ? "取消已读，恢复为未读" : "标记这节小课为已读"}
        onClick={() => void act("lesson-read", () => lesson.read_at
          ? api.unreadLesson(course.id, node.id, lesson.id)
          : api.readLesson(course.id, node.id, lesson.id))}>
        {lesson.read_at && <Check size={14} aria-hidden />}{lesson.read_at ? "已读 · 取消" : "标记已读"}
      </Button>
      <Button type="button" size="sm" onClick={onPractice}
        title="阅读和小课自测不会改变掌握状态；准备好后再做节点验收。">去验收 <ArrowRight /></Button>
    </form>
  </section>;
}
