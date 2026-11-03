import { formatTime } from './formatTime.ts';
import type { Course } from './types';

export type AiTask = {
  id: string; course_id: string; kind: string; target: string; state: string;
  request_id: string; created_at: string; updated_at: string; started_at?: string;
  thread_id?: string; turn_id?: string; error?: string; organization_error?: string;
  applied_revision?: number; superseded_by?: string; result_type?: string;
  inputs?: Record<string, unknown>; raw_reply?: { text?: string };
  result?: unknown; can_recover?: boolean; can_regenerate?: boolean;
  history_matched?: boolean; historical_raw?: string;
  history_only?: boolean; history_kind?: string; history_disposition?: string; history_match_reason?: string;
  result_ref?: { kind: string; course_id: string; available: boolean; checked_revision?: number; node_id?: string; object_id?: string } | null;
  result_object?: unknown; has_raw_reply?: boolean; can_collect?: boolean;
  organization?: { native_status: string; desktop_status: string; checked_at?: string; native_section_id?: string; desktop_section_id?: string };
};
export type TaskView = {
  semantic: 'prepared'|'running'|'processing'|'received'|'conflict'|'unknown'|'applied'|'unverified'|'failed'|'superseded'|'offline'|'missing'|'recovering'|'history';
  title: string; description: string; group: 'attention'|'active'|'applied'|'superseded'|'history';
  canRecover: boolean; canRegenerate: boolean; canOpen: boolean; canCollect: boolean; canOrganize: boolean; canViewRaw: boolean; time: string;
  error?: string; shortLabel: string; newRequestId?: string;
};
export const ACTIVE_STATES = new Set(['prepared','sending','running','processing']);
export const DISPATCH_KINDS = new Set(['bridge','links','bridge_history','assessment','chat','lesson','map','question','recall','lines','retell','goals','note_review']);
const RECOVER_KINDS = new Set([...DISPATCH_KINDS,'assessment']);
export const taskTime = (value: string) => formatTime(value);
export function taskName(task: AiTask, course?: Course) {
  const kind = task.kind === 'history' ? task.history_kind || 'history' : task.kind;
  const verb = {lesson: task.inputs?.kind === 'supplement' ? '补一节小课' : '生成小课', chat:'回复',question:'生成验收题',assessment:'检查作答',bridge:'补充知识桥',links:'重新找前后联系',bridge_backfill:'补充知识桥',bridge_history:'历史知识桥',map:'更新地图',lines:'生成主线',recall:'整理学习内容',retell:'检查复述',goals:'提取目标',note_review:'检查笔记',history:'历史任务'}[kind] || (task.kind === 'history' ? '历史任务' : kind);
  const label = course?.nodes.find(n => n.id === task.target)?.title || course?.edges.find(e => e.id === task.target)?.explanation;
  return label ? `${verb}「${label}」` : verb;
}
export function taskLessonId(task: AiTask, course?: Course) {
  return course?.nodes.find(n => n.id === task.target)?.lessons?.find(l => l.request_id === task.request_id)?.id;
}
export function resultPresent(task: AiTask, course?: Course): boolean {
  if (!course || course.id !== task.course_id || task.state !== 'applied') return false;
  const reference = task.result_ref;
  if (reference !== undefined) return !!reference?.available && reference.course_id === course.id
      && (reference.checked_revision == null || reference.checked_revision <= course.revision);
  if (task.applied_revision == null || course.revision < task.applied_revision) return false;
  if (task.kind === 'lesson') return !!taskLessonId(task, course);
  const node = course.nodes.find(n => n.id === task.target);
  if (task.kind === 'chat') return !!task.raw_reply?.text && !!node?.chats.some(c => c.role === 'assistant' && c.content === task.raw_reply?.text);
  if (task.kind === 'assessment') return !!node?.attempts.some(attempt=>attempt.id===task.request_id);
  // No object IDs are currently exposed for these kinds. A course revision alone is insufficient evidence.
  return false;
}
export function taskView(task: AiTask, course?: Course, options: {offline?:boolean; recovering?:boolean; now?:number} = {}): TaskView {
  const name = taskName(task, course), time = taskTime(task.updated_at || task.created_at);
  const canDispatch = DISPATCH_KINDS.has(task.kind);
  const rawAvailable = !!(task.raw_reply?.text || task.historical_raw || task.has_raw_reply);
  const historyLabel = task.history_disposition === 'already_applied' ? '此前已应用'
    : task.history_disposition === 'conflict' ? '与当前课程冲突'
    : task.history_disposition === 'unmatched' ? '尚未匹配'
    : task.history_disposition === 'recovered' ? '已取回原文'
    : task.history_disposition || '历史原文';
  const base: TaskView = {semantic:'unknown',title:'任务中断，可能已有回复',description:`${name} · 开始于 ${taskTime(task.created_at)}`,group:'attention',canRecover:!task.history_only && task.kind !== 'history' && RECOVER_KINDS.has(task.kind) && (task.can_recover ?? !!(task.raw_reply || task.thread_id)),canRegenerate:!task.history_only && task.kind !== 'history' && canDispatch && (task.can_regenerate ?? true) && task.state !== 'applied',canOpen:false,canCollect:!task.history_only && task.kind !== 'history' && task.can_collect === true,canViewRaw:rawAvailable,time,shortLabel:'中断',newRequestId:task.superseded_by,canOrganize:!task.history_only && task.kind !== 'history' && (!!task.organization_error || task.organization?.native_status === 'failed')};
  if (task.history_only || task.kind === 'history') Object.assign(base,{semantic:'history',title:'历史原文 · '+historyLabel,description:name,group:'history',canRecover:false,canRegenerate:false,canCollect:task.can_collect===true,canOpen:false,shortLabel:historyLabel});
  if (task.state === 'prepared') Object.assign(base,{semantic:'prepared',title:'已发起 · 等待 AI 开始',description:name,group:'active',canRecover:false,canRegenerate:false,shortLabel:'等待开始'});
  if (task.state === 'sending' || task.state === 'running') {
    const seconds = Math.max(0,Math.floor(((options.now ?? Date.now()) - Date.parse(task.started_at || task.created_at))/1000));
    const duration = seconds >= 60 ? `${Math.floor(seconds/60)} 分 ${String(seconds%60).padStart(2,'0')} 秒` : `${seconds} 秒`;
    Object.assign(base,{semantic:'running',title:`正在${name.split('「')[0]}${seconds>=2 ? ` · 已用 ${duration}` : ''}`,description:name,group:'active',canRecover:false,canRegenerate:false,shortLabel:'处理中'});
  }
  if (task.state === 'processing') Object.assign(base,{semantic:'processing',title:'AI 已回复，正在写入课程…',description:name,group:'active',canRecover:false,canRegenerate:false,shortLabel:'正在写入'});
  if (task.state === 'received' || task.state === 'invalid') Object.assign(base,{semantic:'received',title:'AI 已回复，但尚未写入课程',description:`${name} · 回复于 ${time}`,shortLabel:'已回复未写入',error:task.error});
  if (task.state === 'conflict') Object.assign(base,{semantic:'conflict',title:'回复未写入：课程在此期间被修改',description:`已有进度没有被覆盖。${name}`,shortLabel:'未写入：课程已改变',canRecover:task.can_recover === true,error:task.error});
  if (task.state === 'rejected' || task.state === 'failed') Object.assign(base,{semantic:'failed',title:'生成失败',description:task.error || name,canRecover:false,shortLabel:'失败'});
  if (task.state === 'superseded') Object.assign(base,{semantic:'superseded',title:task.superseded_by ? '已另行重新生成，原始结果保留' : '课程已恢复到旧版本，这个任务不会再写入',description:name,group:'superseded',canRecover:false,shortLabel:'已被取代'});
  if (task.state === 'applied') {
    const present = resultPresent(task,course);
    Object.assign(base,{semantic:present?'applied':'unverified',title:present?`已写入课程 · ${time}`:'结果已持久化 · 当前课程对象待核对',description:present?name:`${name}。后端未提供可核对的结果对象，或结果不在当前版本中。`,group:present?'applied':'attention',canRecover:false,canRegenerate:false,canOpen:present,shortLabel:present?'已写入':'当前版本待核对'});
  }
  if (task.state === 'archived' && (task.history_only || task.kind === 'history')) {
    Object.assign(base,{semantic:'history',title:'历史原文 · '+historyLabel,description:name,group:'history',canRecover:false,canRegenerate:false,canCollect:task.can_collect===true,canOpen:false,shortLabel:historyLabel});
  }
  if (!canDispatch && !task.history_only && task.kind !== 'history' && task.state !== 'applied') base.error = `${task.error ? task.error+'。' : ''}此入口暂不支持历史取回或重新生成；原始记录保留。`;
  if(task.kind==='bridge_history'&&task.history_matched!==true)Object.assign(base,{canRecover:false,canRegenerate:false,error:'历史输出与课程输入尚未可靠匹配，原始回复保留供核对，不能应用到当前关系。'});
  if(task.state==='missing')Object.assign(base,{semantic:'missing',title:'后端没有这个任务的记录',description:'可能已被移除，或请求没有到达本地服务。',shortLabel:'后端无记录',canRecover:false,canRegenerate:false,error:'仅保留了请求身份，未取得任务 ID；无法安全重放原始输入。'});
  if (options.offline) return {...base,semantic:'offline',title:'无法连接本地服务，状态未知',description:`上次读到：${base.title}`,canRecover:false,canRegenerate:false,canOpen:false};
  if (options.recovering) return {...base,semantic:'recovering',title:'正在取回结果…',canRecover:true,canRegenerate:false,shortLabel:'正在取回'};
  return base;
}
