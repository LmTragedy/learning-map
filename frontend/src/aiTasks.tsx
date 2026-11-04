import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { ACTIVE_STATES, taskView, type AiTask } from './aiTaskModel';
import type { Course } from './types';
import { TaskCard } from './TaskCard';
import { TaskNotice, TaskTray } from './TaskTray';
import { AI_KEYS, useBusyActivity } from './busyActivity';
import { aiReceiptHints, dropAiReceipts, regenerationRequestId } from './aiReceipts';

/** How long a receipt may go unrecorded by the backend, once no request carries it, before it is dropped. */
const ORPHAN_RECEIPT_MS = 2 * 60_000;

const HIDDEN_KEY='learning-map:hidden-task-cards';
const cardKey=(task:AiTask)=>`${task.id}@${task.updated_at}`;
function useTaskLedger(course: Course | null, onCourse: (course: Course) => void, navigate: (task: AiTask) => void, aiEnabled: boolean) {
  const [tasks,setTasks] = useState<AiTask[]>([]), [loading,setLoading] = useState(false), [error,setError] = useState('');
  const [offline,setOffline] = useState(false), [recovering,setRecovering] = useState<string[]>([]);
  const [regenerating,setRegenerating]=useState<string[]>([]);
  const [importingHistory,setImportingHistory]=useState(false), [importMessage,setImportMessage]=useState('');
  const [openedAt]=useState(()=>Date.now());
  const [open,setOpen] = useState(false), [dismissed,setDismissed] = useState(false), [clock,setClock] = useState(()=>Date.now());
  const [activeEntry,setActiveEntry]=useState('header');
  const [trayFilter,setTrayFilter]=useState<'all'|'attention'>('all');
  // Tasks currently showing in their own place (an inline card or a status slot), so the page reminder never repeats them.
  const [onScreen,setOnScreen]=useState<Record<string,number>>({});
  const markOnScreen=useCallback((ids:string[])=>{
    if(!ids.length)return ()=>{};
    setOnScreen(current=>{const next={...current};ids.forEach(id=>{next[id]=(next[id]||0)+1;});return next;});
    return ()=>setOnScreen(current=>{const next={...current};ids.forEach(id=>{if(--next[id]<=0)delete next[id];});return next;});
  },[]);
  // Cards closed inline, keyed by id@updated_at so a task that changes state shows again. The tray still lists them.
  const [hiddenCards,setHiddenCards]=useState<string[]>(()=>{try{return JSON.parse(localStorage.getItem(HIDDEN_KEY)||'[]');}catch{return [];}});
  const hideCard=(task:AiTask)=>setHiddenCards(current=>{const next=[...current.filter(key=>!key.startsWith(task.id+'@')),cardKey(task)].slice(-200);try{localStorage.setItem(HIDDEN_KEY,JSON.stringify(next));}catch{/* per-viewer convenience only */}return next;});
  const failures = useRef(0), generation = useRef(0), locked = useRef(new Set<string>());
  const detailCache=useRef(new Map<string,AiTask>());
  const inflight=useRef<{epoch:number;promise:Promise<void>}>();
  const activity=useBusyActivity();
  const latest = useRef({course,onCourse,navigate});
  useEffect(()=>{latest.current={course,onCourse,navigate};},[course,onCourse,navigate]);
  const refresh = useCallback(async () => {
    const cid = latest.current.course?.id;
    if (!cid) return;
    const epoch = generation.current;
    if(inflight.current?.epoch===epoch)return inflight.current.promise;
    const read=async()=>{
    setLoading(true);
    try {
      const list = await api.aiTasks(cid);
      const details = await Promise.allSettled(list.map(task => {
        const cached=detailCache.current.get(task.id);
        return cached?.updated_at===task.updated_at&&cached?.state===task.state?Promise.resolve(cached):api.aiTask(cid,task.id);
      }));
      if (epoch !== generation.current) return;
      const full=list.map((task,i) => {const detail=details[i];if(detail.status==='fulfilled'){detailCache.current.set(task.id,detail.value);return detail.value;}return {...detailCache.current.get(task.id),...task};});
      const unrecorded=aiReceiptHints(cid).filter(hint=>!list.some(t=>t.request_id===hint.id));
      // A receipt no request is carrying and the backend never recorded (a recall chat, a request
      // rejected before it became a task) cannot be recovered or replayed, so it is dropped, not shown.
      void dropAiReceipts(unrecorded.filter(hint=>!hint.inFlight&&Date.now()-Date.parse(hint.createdAt)>ORPHAN_RECEIPT_MS).map(hint=>hint.id)).catch(()=>{/* retried on the next refresh */});
      // Still being sent from this page: the backend simply has not recorded it yet.
      const missing=unrecorded.filter(hint=>hint.inFlight).map(hint=>{
        const route=hint.scope.split(' ' ).slice(1).join(' '), target=route.match(/\/nodes\/([^/]+)/)?.[1]||'batch';
        const kind=route.endsWith('/lessons')?'lesson':route.endsWith('/chat')?'chat':route.endsWith('/question')?'question':route.endsWith('/attempts')?'assessment':'unknown';
        return {id:`missing-${hint.id}`,course_id:cid,kind,target,state:'prepared',request_id:hint.id,created_at:hint.createdAt,updated_at:hint.createdAt} satisfies AiTask;
      });
      // Read the course before showing a task as applied, so a finished chat reply never blinks out
      // between leaving the pending list and arriving in the node's saved chats.
      if (list.some(t=>t.state==='applied')) {
        const updated = await api.course(cid);
        if (epoch !== generation.current) return;
        latest.current.onCourse(updated);
      }
      setTasks([...full,...missing]);
      if(details.some(d=>d.status==='rejected')){failures.current++;setError('部分任务详情无法读取。');setOffline(true);}
      else {failures.current=0;setError('');setOffline(false);}
    } catch (failure) {
      if (epoch !== generation.current) return;
      failures.current++;setError(failure instanceof Error ? failure.message : '无法读取任务记录。');setOffline(true);
    } finally {if(epoch===generation.current)setLoading(false);}
    };
    const promise=read();inflight.current={epoch,promise};
    try{await promise;}finally{if(inflight.current?.promise===promise)inflight.current=undefined;}
  },[]);
  const refreshAfterImport=useCallback(async()=>{
    const epoch=generation.current;
    while(inflight.current?.epoch===epoch)await inflight.current.promise;
    if(epoch===generation.current)await refresh();
  },[refresh]);
  useEffect(() => {
    void refresh();
    const epoch=generation;
    return () => {epoch.current++;};
  },[refresh]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>, stopped=false;
    const tick=async()=>{
      if(!stopped&&failures.current<3)await refresh();
      if(!stopped&&failures.current<3)timer=setTimeout(tick,delay());
    };
    // A chat reply streams into the page, so it is polled faster than other work.
    const delay=()=>document.hidden?10000:tasks.some(t=>t.kind==='chat'&&ACTIVE_STATES.has(t.state))?600:2000;
    if(tasks.some(t=>ACTIVE_STATES.has(t.state))||AI_KEYS.has(activity.key)||regenerating.length)timer=setTimeout(tick,delay());
    const changed=()=>{if(failures.current<3)void refresh();};
    window.addEventListener('lm:ai-tasks-changed',changed);
    return ()=>{stopped=true;clearTimeout(timer);window.removeEventListener('lm:ai-tasks-changed',changed);};
  },[refresh,course?.id,tasks,activity.key,offline,regenerating.length]);
  useEffect(()=>{
    if(!tasks.some(t=>ACTIVE_STATES.has(t.state)||t.state==='applied'&&Date.parse(t.updated_at)>=openedAt&&clock-Date.parse(t.updated_at)<4200))return;
    const timer=setInterval(()=>setClock(Date.now()),1000);return ()=>clearInterval(timer);
  },[tasks,clock,openedAt]);
  const viewFor=(task:AiTask)=>{
    const view=taskView(task,course??undefined,{offline,recovering:recovering.includes(task.id),now:clock});
    if(view.newRequestId&&!tasks.some(t=>t.request_id===view.newRequestId))view.newRequestId=undefined;
    return aiEnabled?view:{...view,canRegenerate:false};
  };
  const recover=async(task:AiTask)=>{
    if(locked.current.has(task.id))return;
    locked.current.add(task.id);setRecovering(ids=>[...ids,task.id]);
    try {
      const response=await api.recoverAiTask(task.course_id,task.id);
      if(latest.current.course?.id!==task.course_id)return;
      if(response.course)latest.current.onCourse(response.course);
      await refresh();
      const updated=await api.aiTask(task.course_id,task.id);
      if(updated.state!=='applied')throw new Error(updated.error||'原任务尚未确认完整完成');
      if(latest.current.course?.id===task.course_id)latest.current.navigate(updated);
    } finally {locked.current.delete(task.id);setRecovering(ids=>ids.filter(id=>id!==task.id));}
  };
  const regenerate=async(task:AiTask)=>{
    if(!aiEnabled)throw new Error('AI 辅助已关闭');
    if(locked.current.has(task.id))return;
    const requestId=regenerationRequestId(task.course_id,task.id);locked.current.add(task.id);
    setRegenerating(ids=>[...ids,task.id]);
    try {await api.regenerateAiTask(task.course_id,task.id,requestId);}
    finally {locked.current.delete(task.id);setRegenerating(ids=>ids.filter(id=>id!==task.id));await refresh();}
    const replacement=Array.from(detailCache.current.values()).find(t=>t.request_id===requestId);
    if(replacement&&latest.current.course?.id===task.course_id)latest.current.navigate(replacement);
    return requestId;
  };
  /** Run one action on a task at a time, then cache and show the task as the server now has it. */
  const refreshAfter=async<T,>(task:AiTask,action:()=>Promise<T>,fallback?:(returned:T)=>AiTask):Promise<AiTask>=>{
    if(locked.current.has(task.id))throw new Error('该任务正在处理。');
    locked.current.add(task.id);
    try {
      const returned=await action();
      const reread=api.aiTask(task.course_id,task.id);
      const updated=fallback?await reread.catch(()=>fallback(returned)):await reread;
      detailCache.current.set(task.id,updated);
      if(latest.current.course?.id===task.course_id)setTasks(current=>current.map(saved=>saved.id===task.id?updated:saved));
      return updated;
    } finally {locked.current.delete(task.id);}
  };
  const collect=(task:AiTask)=>refreshAfter(task,()=>api.collectAiTask(task.course_id,task.id));
  // Organizing already returns the task, so a failed re-read can fall back to it.
  const organize=(task:AiTask)=>refreshAfter(task,()=>api.organizeAiTask(task.course_id,task.id),organized=>organized);
  const readResult=async(task:AiTask)=>api.aiTaskResult(task.course_id,task.id);
  const importHistory=async()=>{
    const cid=latest.current.course?.id;
    if(!cid)return;
    setImportingHistory(true);setImportMessage('');
    try {
      const imported=await api.importAiHistory(cid);
      await refreshAfterImport();
      if(latest.current.course?.id===cid)setImportMessage(`已索引 ${imported.tasks.length} 条历史记录；${imported.unmatched} 条未匹配。未启动生成。`);
    } catch(failure) {
      setImportMessage(failure instanceof Error?`历史查找失败：${failure.message}`:'历史查找失败。');
    } finally {setImportingHistory(false);}
  };
  const newConversation=async(nodeId:string)=>{
    const current=latest.current.course;
    if(!current)throw new Error('没有打开的课程。');
    const updated=await api.resetNodeConversation(current.id,nodeId,current.revision);
    if(latest.current.course?.id===current.id)latest.current.onCourse(updated);
    await refresh();
    return updated;
  };
  const select=(task:AiTask)=>{setOpen(false);navigate(task);};
  return {tasks,loading,error,open,setOpen,activeEntry,setActiveEntry,trayFilter,setTrayFilter,onScreen,markOnScreen,dismissed,setDismissed,refresh,recover,regenerate,collect,organize,readResult,importHistory,importingHistory,importMessage,newConversation,viewFor,navigate:select,clock,openedAt,hiddenCards,hideCard};
}
type Ledger=ReturnType<typeof useTaskLedger>;
const Context=createContext<Ledger|null>(null);
export function AiTaskProvider({course,onCourse,onNavigate,aiEnabled,children}:{course:Course|null;onCourse:(course:Course)=>void;onNavigate:(task:AiTask)=>void;aiEnabled:boolean;children:ReactNode}) {
  return <Context.Provider value={useTaskLedger(course,onCourse,onNavigate,aiEnabled)}>{children}</Context.Provider>;
}
// eslint-disable-next-line react-refresh/only-export-components -- the hooks read this file's context
export function useCourseTasks(){const value=useContext(Context);if(!value)throw new Error('缺少 AI 任务上下文');return value;}
const trayProps=(l:Ledger,location:string)=>({tasks:l.tasks,viewFor:l.viewFor,loading:l.loading,error:l.error,open:l.open&&l.activeEntry===location,onOpenChange:(open:boolean)=>{l.setActiveEntry(location);l.setOpen(open);if(!open)l.setTrayFilter('all');},filter:l.trayFilter,onShowAll:()=>l.setTrayFilter('all'),onRefresh:l.refresh,onRecover:l.recover,onRegenerate:l.regenerate,onCollect:l.collect,onOrganize:l.organize,onReadResult:l.readResult,onImportHistory:l.importHistory,importingHistory:l.importingHistory,importMessage:l.importMessage,onNavigate:l.navigate});
export function TaskEntry({location='header'}:{location?:string}){const l=useCourseTasks();return <TaskTray {...trayProps(l,location)}/>;}
type InlineQuery={kind:string|string[];target?:string;taskId?:string};
/** Tasks a TaskCards slot shows, oldest ancestor first; shared with the banner so it never repeats them. */
function inlineTasks(l:Ledger,{kind,target,taskId}:InlineQuery){
  const kinds=Array.isArray(kind)?kind:[kind];
  // Archived history and superseded runs need nothing from the learner; they live in the tray, not inline,
  // so a late-loading record never pushes the page down.
  const relevant=l.tasks.filter(t=>kinds.includes(t.kind)&&(taskId===t.id||!['history','superseded'].includes(l.viewFor(t).group)&&!l.hiddenCards.includes(cardKey(t)))&&(target===undefined||t.target===target)&&(!taskId||t.id===taskId)&&(t.state!=='applied'||Date.parse(t.updated_at)>=l.openedAt&&l.clock-Date.parse(t.updated_at)<4000));
  const tasks:AiTask[]=[], inserted=new Set<string>();
  const append=(task:AiTask)=>{if(inserted.has(task.id))return;inserted.add(task.id);const parent=relevant.find(t=>t.superseded_by===task.request_id);if(parent)append(parent);tasks.push(task);};
  relevant.forEach(append);
  return tasks;
}
function useOnScreen(l:Ledger,ids:string[]){
  const key=ids.join(' ');
  const {markOnScreen}=l;
  useEffect(()=>markOnScreen(key?key.split(' '):[]),[markOnScreen,key]);
}
export function TaskCards({limit=2,...query}:InlineQuery&{limit?:number}) {
  const l=useCourseTasks(), tasks=inlineTasks(l,query);
  useOnScreen(l,tasks.slice(0,limit).map(t=>t.id));
  return <div className="task-stack">{tasks.slice(0,limit).map(task=><TaskCard key={task.id} task={task} view={l.viewFor(task)} onRefresh={l.refresh} onRecover={()=>l.recover(task)} onRegenerate={()=>l.regenerate(task)} onCollect={()=>l.collect(task)} onOrganize={()=>l.organize(task)} onReadResult={()=>l.readResult(task)} onOpen={()=>l.navigate(task)} onDismiss={query.taskId||ACTIVE_STATES.has(task.state)?undefined:()=>l.hideCard(task)} onNewTask={rid=>{const child=l.tasks.find(t=>t.request_id===rid);if(child)l.navigate(child);else l.setOpen(true);}}/>)}{tasks.length>limit&&<button type="button" className="task-more" onClick={()=>l.setOpen(true)}>还有 {tasks.length-limit} 个 AI 任务<span aria-hidden="true">→</span></button>}</div>;
}
/** Course-wide work with no panel of its own shows as cards under the header. */
const GLOBAL_KINDS=['map','lines','recall','retell','goals','bridge_history','problem_unit','problem_link'];
/** A status slot for one kind of task (e.g. the batch bridge run), drawn by the caller where that task was started. */
export function TaskSlot({kind,target,children}:{kind:string;target:string;children:(task:AiTask|undefined,view:ReturnType<Ledger['viewFor']>|undefined,dismiss:()=>void)=>ReactNode}){
  const l=useCourseTasks();
  const task=l.tasks.find(t=>t.kind===kind&&t.target===target&&!l.hiddenCards.includes(cardKey(t))&&(ACTIVE_STATES.has(t.state)||l.viewFor(t).group==='attention'||t.state==='applied'&&Date.parse(t.updated_at)>=l.openedAt));
  useOnScreen(l,task?[task.id]:[]);
  return <>{children(task,task&&l.viewFor(task),()=>task&&l.hideCard(task))}</>;
}
export function TaskBanners(){
  const l=useCourseTasks();
  const cards=inlineTasks(l,{kind:GLOBAL_KINDS});
  return <>{!l.dismissed&&<TaskNotice tasks={l.tasks.filter(t=>!l.onScreen[t.id])} viewFor={l.viewFor} onNavigate={l.navigate} onViewAll={()=>{l.setTrayFilter('attention');l.setActiveEntry('header');l.setOpen(true);}} onDismiss={()=>l.setDismissed(true)}/>}{cards.length>0&&<div className="task-global"><TaskCards kind={GLOBAL_KINDS} /></div>}</>;
}
