import { useState } from "react";
import { formatTime } from "./formatTime";
import { AlertCircle, LoaderCircle, Sparkles } from "lucide-react";
import type { Chat, RecallSummary } from "./types";
import { Button } from "./components/ui/button";
import { AiMark } from "./components/ui/ai-mark";

type RecallPanelProps = {
  messages: Chat[];
  note: string;
  aiEnabled: boolean;
  busy: boolean;
  onSummarize: () => Promise<RecallSummary | undefined>;
  reviewLabel?: string;
  activeMessageCount?: number;
};

export function RecallPanel({
  messages,
  note,
  aiEnabled,
  busy,
  onSummarize,
  reviewLabel,
  activeMessageCount,
}: RecallPanelProps) {
  const [summary, setSummary] = useState<RecallSummary>();
  const [failure, setFailure] = useState("");
  const canSummarize = aiEnabled && (activeMessageCount ?? messages.length) > 0 && !busy;

  const summarize = async () => {
    setFailure("");
    const generated = await onSummarize();
    if (!generated) {
      setFailure("整理没有完成；原始对话和已有整理结果仍保留，可以稍后重试。");
      return;
    }
    setSummary(generated);
  };

  return (
    <div className="modal-body recall-panel">
      <div className="recall-note">
        <AlertCircle size={17} />
        <span>{note}</span>
      </div>
      <div className="recall-summary-action">
        <div>
          <strong>整理学习内容</strong>
          <span>根据本节点保存的对话生成带原文依据的学习脉络。</span>
          {reviewLabel && <small className="review-recall-label">{reviewLabel}</small>}
        </div>
        <Button
          
          onClick={() => void summarize()}
          disabled={!canSummarize}
        >
          {busy ? <LoaderCircle size={15} /> : <Sparkles size={15} />}
          {busy ? "正在整理…" : summary ? "重新整理" : "开始整理"}
        </Button>
      </div>
      {!aiEnabled && (
        <p className="recall-unavailable">
          请先在设置中启用 AI；原始对话仍可查看。
        </p>
      )}
      {aiEnabled && messages.length === 0 && (
        <p className="recall-unavailable">
          这个节点还没有历史对话，暂时无法整理。
        </p>
      )}
      {aiEnabled && (activeMessageCount ?? messages.length) === 0 && messages.length > 0 && (
        <p className="recall-unavailable">当前复习范围没有可整理的对话；全部历史仍可在下方查看。</p>
      )}
      {failure && <p className="recall-failure" role="alert">{failure}</p>}
      {summary && <RecallSummaryView summary={summary} label={reviewLabel} />}
      <RecallOriginals messages={messages} open={!summary} />
    </div>
  );
}

function RecallSummaryView({ summary, label }: { summary: RecallSummary; label?: string }) {
  const messageById = new Map(summary.messages.map((message) => [message.id, message]));

  return (
    <section className="recall-summary" aria-live="polite">
      <div className="recall-summary-heading">
        <div>
          <span>{label || "AI 根据实际对话整理"}</span>
          <h3>{summary.title}</h3>
        </div>
        <small>
          {formatTime(summary.created_at)} · 对话版本 {summary.history_revision}
        </small>
      </div>
      <div className="recall-items">
        {summary.items.map((entry, index) => (
          <RecallEntry
            key={`${entry.category}-${index}`}
            entry={entry}
            messageById={messageById}
          />
        ))}
      </div>
      {summary.uncertainties.length > 0 && (
        <div className="recall-uncertainties">
          <strong>需要留意</strong>
          <ul>
            {summary.uncertainties.map((uncertainty, index) => (
              <li key={`${index}-${uncertainty}`}>{uncertainty}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="recall-mastery-note">
        <AiMark /> 用来接上你的学习思路，不改变掌握状态。
        它已保存为本节点的学习记忆：之后新开的学习对话、出题和小课会带上它和最近几条对话，再次整理会替换它。
      </p>
    </section>
  );
}

function RecallEntry({
  entry,
  messageById,
}: {
  entry: RecallSummary["items"][number];
  messageById: Map<string, Chat>;
}) {
  return (
    <article className="recall-item">
      <div className="recall-item-heading">
        <strong>{entry.category}</strong>
        <span>AI 归纳</span>
      </div>
      <p>{entry.content}</p>
      {entry.evidence_ids.length > 0 ? (
        <details className="recall-evidence">
          <summary>查看引用原文（{entry.evidence_ids.length}）</summary>
          {entry.evidence_ids.map((id) => (
            <RecallEvidence key={id} message={messageById.get(id)} />
          ))}
        </details>
      ) : (
        <span className="recall-no-evidence">没有可展示的原文引用</span>
      )}
    </article>
  );
}

function RecallEvidence({ message }: { message?: Chat }) {
  if (!message) {
    return <p className="recall-missing-evidence">引用的对话原文当前不可用。</p>;
  }

  return (
    <div className="recall-evidence-entry">
      <a href={`#recall-message-${message.id}`}>
        跳到{message.role === "user" ? "我的发言" : "AI 回复"}
      </a>
      <p>{message.content}</p>
    </div>
  );
}

function RecallOriginals({ messages, open }: { messages: Chat[]; open: boolean }) {
  return (
    <details className="recall-originals" open={open}>
      <summary>本节点原始对话（{messages.length} 条）</summary>
      {messages.length ? (
        <div className="recall-messages">
          {messages.map((message) => (
            <article
              id={`recall-message-${message.id}`}
              key={message.id}
              className={`recall-message ${message.role === "assistant" ? "assistant" : ""}`}
            >
              <span>{message.role === "assistant" ? "AI 导师" : "我"}</span>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-note">
          <p>这个节点还没有历史对话</p>
          <span>开始学习对话后，这里会基于实际记录帮助你接续思路。</span>
        </div>
      )}
    </details>
  );
}
