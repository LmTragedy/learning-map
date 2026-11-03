import { useState, useSyncExternalStore } from 'react'
import { Paperclip, RefreshCw, Sparkles } from 'lucide-react'
import { api } from './api'
import { answerDraft, completeAnswerDraft, subscribeAnswerDrafts, updateAnswerDraft } from './answerDrafts'
import { BridgeGaps } from './BridgeGaps'
import type { Attempt, Course, LearningNode } from './types'

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
  const draft = useSyncExternalStore(subscribeAnswerDrafts, () => answerDraft(scope))
  const { answer, reference, files, warning } = draft
  const [problem, setProblem] = useState<number | null>(null)
  const [mastery, setMastery] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const latest = node.attempts.at(-1)

  const act = async (key: string, request: () => Promise<Course>) => {
    const updated = await run(key, request)
    if (updated) onRefresh(updated)
    return updated
  }
  const submitAttempt = async () => {
    const updated = await act('attempt', () => api.attempt(course.id, node.id, answer, reference, files))
    if (updated) completeAnswerDraft(scope, draft)
  }
  const submitRating = async (attempt: Attempt, skip: boolean) => {
    const updated = await act('rating', () => api.rate(course.id, node.id, attempt.id, { problem: skip ? null : problem, mastery: skip ? null : mastery, comment, skip }))
    if (!updated) return
    // Start the next attempt's rating from blank instead of carrying these scores over.
    setProblem(null); setMastery(null); setComment('')
    if (!skip) onRatingSubmitted()
  }

  const askQuestion = () => void act('question', () => api.question(course.id, node.id))
  return <div className="practice-pane">
    <div className="practice-main">
      <div className="practice-question">
        <div className="practice-question-head">
          <span className="eyebrow">{node.question?.kind || '节点验收'}</span>
          {node.question && <button className="link-button" onClick={askQuestion} disabled={busy || !aiEnabled}><RefreshCw size={13}/>换一道题</button>}
        </div>
        {node.question
          ? <p>{node.question.prompt}</p>
          : <><p className="muted">生成一道基于当前节点的验收题，检查理解和应用。</p>
            <button className="primary" onClick={askQuestion} disabled={busy || !aiEnabled}><Sparkles size={15}/>生成验收题</button></>}
      </div>
      <div className="practice-editor">
        <textarea rows={10} aria-label="你的作答" value={answer} onChange={event => updateAnswerDraft(scope, { answer: event.target.value })} placeholder="写出你的思路、步骤或解释" disabled={!aiEnabled}/>
        {files.length > 0 && <div className="file-chips">{files.map(file => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}</div>}
        <div className="practice-editor-foot">
          <label className={`upload-inline ${!aiEnabled ? 'disabled' : ''}`} title={files.length ? '刷新页面后需要重新选择附件' : undefined}><Paperclip size={14}/>照片或 PDF<input type="file" accept="image/*,.pdf" multiple disabled={!aiEnabled} onChange={event => updateAnswerDraft(scope, { files: Array.from(event.target.files || []) })}/></label>
          {warning ? <span className="muted small" role="alert">{warning}</span> : (answer || reference) && <span className="muted small" title="保存在当前浏览器">草稿已保存</span>}
          <button className="primary" onClick={() => void submitAttempt()} disabled={busy || !aiEnabled || !node.question || (!answer.trim() && files.length === 0)}>提交作答并验收</button>
        </div>
      </div>
      <details className="reference-answer" open={Boolean(reference) || undefined}>
        <summary>＋ 参考答案（可选）</summary>
        <textarea rows={2} aria-label="参考答案" value={reference} onChange={event => updateAnswerDraft(scope, { reference: event.target.value })} placeholder="有参考答案时可以附上" disabled={!aiEnabled}/>
      </details>
    </div>
    <aside className="practice-side" aria-label="验收结果">
      {latest ? <>
        <AttemptResult attempt={latest} busy={busy} problem={problem} mastery={mastery} comment={comment} onProblem={setProblem} onMastery={setMastery} onComment={setComment} onResolve={decision => void act('resolve', () => api.resolve(course.id, node.id, latest.id, decision))} onRating={skip => void submitRating(latest, skip)}/>
        {latest.judgment.outcome !== 'passed' && <BridgeGaps course={course} node={node} attempt={latest} busy={busy} act={act} onNavigate={onNavigate}/>}
      </> : <p className="muted small">提交作答后，判定结果会显示在这里。</p>}
    </aside>
  </div>
}

function AttemptResult({ attempt, busy, problem, mastery, comment, onProblem, onMastery, onComment, onResolve, onRating }: { attempt: Attempt; busy: boolean; problem: number | null; mastery: number | null; comment: string; onProblem: (score: number) => void; onMastery: (score: number) => void; onComment: (text: string) => void; onResolve: (decision: 'pass' | 'supplement' | 'review') => void; onRating: (skip: boolean) => void }) {
  const outcome = { passed: '本次通过', failed: '还需要补充', uncertain: '暂时无法确定' }[attempt.judgment.outcome]
  return <div className="result-card">
    <div className="result-head"><strong className={`outcome outcome-${attempt.judgment.outcome}`}>{outcome}</strong>{attempt.rating_state !== 'pending' && <span className="muted small">{attempt.rating_state === 'skipped' ? '已跳过评分' : '已评分'}</span>}</div>
    <p>{attempt.judgment.reasoning}</p>
    {attempt.judgment.blockers.length > 0 && <ul>{attempt.judgment.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
    <p className="muted small">下一步：{attempt.judgment.next_step}</p>
    {attempt.judgment.outcome === 'uncertain' && !attempt.resolution && <div className="decision-row"><button disabled={busy} onClick={() => onResolve('pass')}>仍按通过</button><button disabled={busy} onClick={() => onResolve('supplement')}>补充练习</button><button disabled={busy} onClick={() => onResolve('review')}>通过并待复查</button></div>}
    {attempt.rating_state === 'pending' && <div className="rating-box"><h4>这次学习体验如何？ <span className="muted">可跳过</span></h4><ScorePicker label="问题解决程度" value={problem} onChange={onProblem}/><ScorePicker label="知识掌握程度" value={mastery} onChange={onMastery}/><label className="field-label">补充反馈（可选）<input value={comment} onChange={event => onComment(event.target.value)} placeholder="比如：哪个解释最有帮助？"/></label><div className="decision-row"><button onClick={() => onRating(true)} disabled={busy}>跳过评分</button><button className="primary" onClick={() => onRating(false)} disabled={busy || (problem === null && mastery === null)}>提交评分</button></div></div>}
  </div>
}

function ScorePicker({ label, value, onChange }: { label: string; value: number | null; onChange: (score: number) => void }) {
  return <div className="score-row"><span>{label}</span><div>{[0, 1, 2, 3, 4].map(score => <button className={value === score ? 'chosen' : ''} key={score} onClick={() => onChange(score)} aria-label={`${label} ${score}分`}>{score}</button>)}</div></div>
}
