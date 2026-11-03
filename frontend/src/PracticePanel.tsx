import { useEffect, useState, useSyncExternalStore } from 'react'
import { BookCheck, Paperclip, Play, RefreshCw, SkipForward, Sparkles } from 'lucide-react'
import { api, problemImageUrl } from './api'
import { answerDraft, completeAnswerDraft, subscribeAnswerDrafts, updateAnswerDraft } from './answerDrafts'
import { BridgeGaps } from './BridgeGaps'
import type { Attempt, Course, LearningNode } from './types'
import { TaskCards, useCourseTasks } from './aiTasks'
import { Button } from './components/ui/button'
import './problemBank.css'
import { nodeProblems, problemRef, STATUS_LABEL } from './problemStatus'

type Props = {
  course: Course
  node: LearningNode
  busy: boolean
  aiEnabled: boolean
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>
  onRefresh: (course: Course) => void
  onRatingSubmitted: () => void
  onNavigate: (node: LearningNode, edge?: Course['edges'][number]) => void
}

export function PracticePanel({ course, node, busy, aiEnabled, run, onRefresh, onRatingSubmitted, onNavigate }: Props) {
  const scope = JSON.stringify([course.id, node.id, course.review_scope.key, node.question ?? null])
  const progress = node.practice_progress
  const uiStateKey = JSON.stringify([scope, progress?.question_key ?? null])
  const draft = useSyncExternalStore(subscribeAnswerDrafts, () => answerDraft(scope))
  const { answer, reference, files, warning } = draft
  const [rating, setRating] = useState<{ key: string; problem: number | null; mastery: number | null; comment: string }>({ key: '', problem: null, mastery: null, comment: '' })
  const [independentState, setIndependentState] = useState<{ key: string; value: boolean }>({ key: '', value: false })
  const problem = rating.key === uiStateKey ? rating.problem : null
  const mastery = rating.key === uiStateKey ? rating.mastery : null
  const comment = rating.key === uiStateKey ? rating.comment : ''
  const independent = independentState.key === uiStateKey ? independentState.value : false
  const currentQuestionAttempts = node.question
    ? node.attempts.filter(attempt => JSON.stringify(attempt.question) === JSON.stringify(node.question))
    : []
  const chain = progress
    ? node.attempts.filter(attempt => progress.attempt_ids.includes(attempt.id))
    : currentQuestionAttempts
  const latest = chain.at(-1)
  // Only one white button at a time: answering, unless the last attempt is waiting for its rating.
  const answerIsMain = Boolean(node.question) && latest?.rating_state !== 'pending'

  const act = async (key: string, request: () => Promise<Course>) => {
    const updated = await run(key, request)
    if (updated) onRefresh(updated)
    return updated
  }
  const submitAttempt = async () => {
    const updated = await act('attempt', async () => {
      const questionKey = progress?.question_key ?? await practiceQuestionKey(node.question)
      return api.attempt(course.id, node.id, answer, reference, files, {
        ...(latest && !independent ? { base_attempt_id: latest.id } : {}),
        question_key: questionKey,
      })
    })
    if (updated) completeAnswerDraft(scope, draft)
  }
  const submitRating = async (attempt: Attempt, skip: boolean) => {
    const updated = await act('rating', () => api.rate(course.id, node.id, attempt.id, { problem: skip ? null : problem, mastery: skip ? null : mastery, comment, skip }))
    if (!updated) return
    // Start the next attempt's rating from blank instead of carrying these scores over.
    setRating({ key: uiStateKey, problem: null, mastery: null, comment: '' })
    if (!skip) onRatingSubmitted()
  }

  const askQuestion = () => void act('question', () => api.question(course.id, node.id))
  // Real problems the learner linked to this node come first: practise them directly; AI questions follow their standard.
  const linkedProblems = nodeProblems(course, node.id)
  const realCount = linkedProblems.filter(({ set }) => set.origin === 'real').length
  const passedCount = linkedProblems.filter(({ status }) => status === 'passed').length
  const currentRef = node.question?.problem_ref
  const nextProblem = linkedProblems.find(({ set, problem, status }) => status !== 'passed' && problemRef(set, problem) !== currentRef)
  // Without real problems of its own, the node's AI questions follow the closest ones in the bank; show which.
  const hasBank = (course.problem_sets || []).some(set => set.origin === 'real' && set.problems.length > 0)
  const ownReal = linkedProblems.some(({ set }) => set.origin === 'real')
  const [references, setReferences] = useState<{ key: string; items: Awaited<ReturnType<typeof api.problemReferences>> }>()
  const referenceKey = `${course.id}:${node.id}:${course.revision}`
  useEffect(() => {
    if (!hasBank || ownReal) return
    let live = true
    api.problemReferences(course.id, node.id).then(items => { if (live) setReferences({ key: referenceKey, items }) }).catch(() => undefined)
    return () => { live = false }
  }, [course.id, node.id, referenceKey, hasBank, ownReal])
  const shownReferences = references?.key === referenceKey ? references.items : []
  const practiseProblem = (setId: string, problemId: string) => void act('problem-practise', () => api.practiseProblem(course.id, node.id, setId, problemId))
  const tasks=useCourseTasks().tasks
  const asking=tasks.some(t=>t.kind==='question'&&t.target===node.id&&t.state!=='applied')
  const judging=tasks.some(t=>t.kind==='assessment'&&t.target===node.id&&t.state!=='applied')
  return <div className="practice-pane">
    <div className="practice-main">
      <div className="practice-question">
        <div className="practice-question-head">
          <span className="eyebrow">{node.question?.kind || '节点验收'}</span>
          {node.question && (nextProblem
            ? <button className="link-button" onClick={() => practiseProblem(nextProblem.set.id, nextProblem.problem.id)} disabled={busy || asking || judging}><SkipForward size={13}/>下一道真题</button>
            : <button className="link-button" onClick={askQuestion} disabled={busy || asking || !aiEnabled}><RefreshCw size={13}/>{realCount ? 'AI 按真题出一道' : '换一道题'}</button>)}
        </div>
        {asking
          ? <TaskCards kind="question" target={node.id} />
          : node.question
          ? <><p className="practice-prompt" style={{ whiteSpace: 'pre-wrap' }}>{node.question.images?.length
              // With screenshots the picture is the problem; show its label and the set's shared instructions only.
              ? [node.question.prompt.split('\n')[0], course.problem_sets?.find(set => set.id === currentRef?.split('/')[0])?.instructions].filter(Boolean).join('\n')
              : node.question.prompt}</p>
            {!!node.question.images?.length && <Screens course={course} refs={node.question.images} label="题目" />}
            {/* The answer stays hidden until there is an attempt on this question. */}
            {!!node.question.answer_images?.length && latest && <details className="practice-answer"><summary>查看参考答案截图</summary><Screens course={course} refs={node.question.answer_images} label="答案" /></details>}</>
          : nextProblem
          ? <><p className="muted">本知识点有 {realCount} 道真题，直接从真题开始练。</p>
            <div className="decision-row"><Button onClick={() => practiseProblem(nextProblem.set.id, nextProblem.problem.id)} disabled={busy}><Play size={15}/>练真题</Button>
              <Button variant="outline" onClick={askQuestion} disabled={busy || !aiEnabled}><Sparkles size={15}/>AI 按真题出一道</Button></div></>
          : <><p className="muted">{hasBank
              ? '本知识点还没有自己的真题。AI 会参考题库里内容最相近的真题，按同样的题型和难度出一道。'
              : '生成一道基于当前节点的验收题，检查理解和应用。'}</p>
            <Button  onClick={askQuestion} disabled={busy || !aiEnabled}><Sparkles size={15}/>生成验收题</Button></>}
        {!asking && !ownReal && shownReferences.length > 0 && <div className="practice-real">
          <div className="practice-real-head"><span>AI 出题会参考这些真题</span></div>
          <ul>{shownReferences.map(item => <li key={item.problem_id}>
            <span className="pb-status">{item.relation.replace('同课程其他真题', '其他').replace('的真题', '').replace('与本知识点', '')}</span>
            <span>{item.set_title}{item.number ? ` 第${item.number}题` : ''}</span>
          </li>)}</ul>
        </div>}
        {!asking && linkedProblems.length > 0 && <div className="practice-real">
          <div className="practice-real-head"><span>本知识点的题目 · {linkedProblems.length} 道{realCount ? `（真题 ${realCount}）` : ''}</span><span>通过 {passedCount}</span></div>
          <ul>{linkedProblems.map(({ set, problem, status }) => <li key={problem.id} className={problemRef(set, problem) === currentRef ? 'is-current' : ''}>
            <span className={`pb-status is-${status}`}>{STATUS_LABEL[status]}</span>
            <span title={problem.text}>{set.origin === 'real' ? '' : 'AI · '}{set.title}{problem.number ? ` 第${problem.number}题` : ''}{problem.text ? ` · ${problem.text.replace(/^\s*\S+\s*/, '').slice(0, 50)}` : ''}</span>
            {problemRef(set, problem) === currentRef
              ? <span className="muted small">正在练</span>
              : <button className="link-button" disabled={busy || judging} onClick={() => practiseProblem(set.id, problem.id)}><BookCheck size={13}/>练这道</button>}
          </li>)}</ul>
        </div>}
      </div>
      <div className="practice-editor">
        {latest && <p className="muted small">默认补充同一道题的上一份作答；选择独立重答后，本次不会引用旧答案。</p>}
        {latest && <label className="small"><input type="checkbox" checked={independent} onChange={event => setIndependentState({ key: uiStateKey, value: event.target.checked })}/> 独立重答</label>}
        <textarea rows={10} aria-label="你的作答" value={answer} onChange={event => updateAnswerDraft(scope, { answer: event.target.value })} placeholder="写出你的思路、步骤或解释" disabled={!aiEnabled}/>
        {files.length > 0 && <div className="file-chips">{files.map(file => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}<small className="muted">附件不随草稿保存，刷新页面后需要重新选择。</small></div>}
        <div className="practice-editor-foot">
          <label className={`upload-inline ${!aiEnabled ? 'disabled' : ''}`}><Paperclip size={14}/>照片或 PDF<input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" multiple disabled={!aiEnabled} onChange={event => updateAnswerDraft(scope, { files: Array.from(event.target.files || []) })}/></label>
          {warning ? <span className="muted small" role="alert">{warning}</span> : (answer || reference) && <span className="muted small">草稿已保存在本浏览器</span>}
          <Button variant={answerIsMain ? 'default' : 'outline'} onClick={() => void submitAttempt()} disabled={busy || judging || !aiEnabled || !node.question || (!answer.trim() && files.length === 0)}>提交作答并验收</Button>
        </div>
      </div>
      <details className="reference-answer" open={Boolean(reference) || undefined}>
        <summary>＋ 参考答案（可选）</summary>
        <textarea rows={2} aria-label="参考答案" value={reference} onChange={event => updateAnswerDraft(scope, { reference: event.target.value })} placeholder="有参考答案时可以附上" disabled={!aiEnabled}/>
      </details>
    </div>
    <aside className="practice-side" aria-label="验收结果">
      {judging && <TaskCards kind="assessment" target={node.id} />}
      {progress && <section className="result-card">
        <div className="result-head"><strong>同题作答进度</strong><button className="link-button" onClick={() => downloadMarkdown(progress.markdown)}>下载进度 Markdown</button></div>
        {progress.confirmed_points.map(point => <p key={point.id}>✓ {point.point} <span className="muted small">“{point.quote}”</span></p>)}
        {progress.blockers.map((blocker, index) => <p key={`${index}-${blocker}`}>待补充：{blocker}</p>)}
      </section>}
      {/* The latest attempt is the result card below, so the history lists only the earlier ones. */}
      {chain.length > 1 && <details className="result-card"><summary>同题历史作答（{chain.length - 1}）</summary>{chain.slice(0, -1).map((attempt, index) => <article key={attempt.id}>
        <h4>第 {index + 1} 次 · AI 原判：{outcomeLabel(attempt.judgment.outcome)}{attempt.resolution ? ` · 用户决定：${resolutionLabel(attempt.resolution)}` : ''}</h4>
        <p style={{ whiteSpace: 'pre-wrap' }}>{attempt.answer || '（未附文字）'}</p>
        {attempt.attachments.map(file => <details key={file.id}><summary>{file.name}</summary>{file.pages.map(page => <p key={page.number} className="muted small">第 {page.number} 页：{page.text}</p>)}</details>)}
        <p className="muted small">AI 说明：{attempt.judgment.reasoning}</p>
      </article>)}</details>}
      {node.attempts.some(attempt => !chain.some(current => current.id === attempt.id)) && <details className="result-card"><summary>其他题目 / 旧记录（{node.attempts.filter(attempt => !chain.some(current => current.id === attempt.id)).length}）</summary>{node.attempts.filter(attempt => !chain.some(current => current.id === attempt.id)).map(attempt => <article key={attempt.id}>
        <h4>{attempt.question.prompt}</h4><p style={{ whiteSpace: 'pre-wrap' }}>{attempt.answer || '（未附文字）'}</p><p className="muted small">AI 原判：{outcomeLabel(attempt.judgment.outcome)}{attempt.resolution ? ` · 用户决定：${resolutionLabel(attempt.resolution)}` : ''}</p>
      </article>)}</details>}
      {latest ? <>
        <AttemptResult attempt={latest} busy={busy} problem={problem} mastery={mastery} comment={comment} onProblem={score => setRating({ key: uiStateKey, problem: score, mastery, comment })} onMastery={score => setRating({ key: uiStateKey, problem, mastery: score, comment })} onComment={text => setRating({ key: uiStateKey, problem, mastery, comment: text })} onResolve={decision => void act('resolve', () => api.resolve(course.id, node.id, latest.id, decision))} onRating={skip => void submitRating(latest, skip)}/>
        {latest.judgment.outcome !== 'passed' && <BridgeGaps course={course} node={node} attempt={latest} busy={busy} act={act} onNavigate={onNavigate}/>}
      </> : <p className="muted small">提交作答后，判定结果会显示在这里。</p>}
    </aside>
  </div>
}

async function practiceQuestionKey(question: LearningNode['question']): Promise<string> {
  if (!question) return '';
  // Must match backend question_key: top-level keys sorted; real problems add images/answer_images/problem_ref.
  const record = question as Record<string, unknown>;
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function outcomeLabel(outcome: Attempt['judgment']['outcome']) {
  return { passed: '通过', failed: '需补充', uncertain: '不确定' }[outcome]
}

function resolutionLabel(resolution: string) {
  return ({ pass: '按通过处理', supplement: '选择补充练习', review: '通过并待复查' } as Record<string, string>)[resolution] ?? '已作出处理'
}

function downloadMarkdown(markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'practice-progress.md'
  link.click()
  URL.revokeObjectURL(url)
}

function AttemptResult({ attempt, busy, problem, mastery, comment, onProblem, onMastery, onComment, onResolve, onRating }: { attempt: Attempt; busy: boolean; problem: number | null; mastery: number | null; comment: string; onProblem: (score: number) => void; onMastery: (score: number) => void; onComment: (text: string) => void; onResolve: (decision: 'pass' | 'supplement' | 'review') => void; onRating: (skip: boolean) => void }) {
  const outcome = attempt.resolution
    ? resolutionLabel(attempt.resolution)
    : { passed: '本次通过', failed: '还需要补充', uncertain: '暂时无法确定' }[attempt.judgment.outcome]
  return <div className="result-card">
    <div className="result-head"><strong className={`outcome outcome-${attempt.judgment.outcome}`}>{attempt.resolution ? `用户决定：${outcome}` : outcome}</strong>{attempt.resolution && <span className="muted small">AI 原判：{outcomeLabel(attempt.judgment.outcome)}</span>}{attempt.rating_state !== 'pending' && <span className="muted small">{attempt.rating_state === 'skipped' ? '已跳过评分' : '已评分'}</span>}</div>
    <p>{attempt.judgment.reasoning}</p>
    {attempt.judgment.blockers.length > 0 && <ul>{attempt.judgment.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
    <p className="muted small">下一步：{attempt.judgment.next_step}</p>
    {attempt.judgment.outcome === 'uncertain' && !attempt.resolution && <div className="decision-row"><button disabled={busy} onClick={() => onResolve('pass')}>仍按通过</button><button disabled={busy} onClick={() => onResolve('supplement')}>补充练习</button><button disabled={busy} onClick={() => onResolve('review')}>通过并待复查</button></div>}
    {attempt.rating_state === 'pending' && <div className="rating-box"><h4>这次学习体验如何？ <span className="muted">可跳过</span></h4><ScorePicker label="问题解决程度" value={problem} onChange={onProblem}/><ScorePicker label="知识掌握程度" value={mastery} onChange={onMastery}/><label className="field-label">补充反馈（可选）<input value={comment} onChange={event => onComment(event.target.value)} placeholder="比如：哪个解释最有帮助？"/></label><div className="decision-row"><Button variant="ghost" onClick={() => onRating(true)} disabled={busy}>跳过评分</Button><Button  onClick={() => onRating(false)} disabled={busy || (problem === null && mastery === null)}>提交评分</Button></div></div>}
  </div>
}

function ScorePicker({ label, value, onChange }: { label: string; value: number | null; onChange: (score: number) => void }) {
  return <div className="score-row"><span>{label}</span><div>{[0, 1, 2, 3, 4].map(score => <button className={value === score ? 'chosen' : ''} key={score} onClick={() => onChange(score)} aria-label={`${label} ${score}分`}>{score}</button>)}</div></div>
}

function Screens({ course, refs, label }: { course: Course; refs: string[]; label: string }) {
  return <div className="practice-shots">{refs.map((ref, index) =>
    <a key={ref} href={problemImageUrl(course.id, ref)} target="_blank" rel="noreferrer" title="打开原图">
      <img src={problemImageUrl(course.id, ref)} alt={`${label}截图 ${index + 1}`} loading="lazy" decoding="async" /></a>)}</div>
}
