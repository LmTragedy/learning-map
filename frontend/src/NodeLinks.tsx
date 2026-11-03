import { useState } from "react";
import { ArrowRight, ArrowUpRight, CornerDownRight, NotebookPen, Sparkles } from "lucide-react";
import { appendBlock, mainNoteTitle } from "./noteFormatting";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { chain, isStrong, isWeak, nodeBridges, pieceLabel, resolveBridges, STRENGTH_LABEL, type ResolvedBridge } from "./bridges";
import { BridgeCheck } from "./BridgeCheck";
import { TaskCards } from "./aiTasks";
import type { Course, LearningNode, Source, Step } from "./types";
import "./nodeLinks.css";

type Edge = Course["edges"][number];
type Selected =
  | { kind: "bridge"; item: ResolvedBridge; side: "in" | "out" }
  | { kind: "step"; step: Step; index: number }
  | { kind: "chain"; item: ResolvedBridge; direction: "before" | "after" };

/** How far each chain is followed: back to the roots, and ahead to where the node is still used. */
const DEPTH_BEFORE = 2;
const DEPTH_AFTER = 3;
const done = (node: LearningNode) => node.status === "passed" || node.status === "mastered";

/**
 * One node's links read row by row along its steps: what each step uses (left), traced back to the
 * earlier knowledge it rests on, and what later nodes build on it (right), traced on to where it is
 * still used much later. Clicking anything shows its wording; earlier pieces carry their self-check.
 * This is the only place a node's knowledge bridges are listed.
 */
export function NodeLinks({ course, node, busy, aiEnabled, reviewStrict, act, canOpen, onNavigate, onOpenBridge, onOpenSource, notice, onNotice }: {
  course: Course; node: LearningNode; busy: boolean; aiEnabled: boolean; reviewStrict: boolean;
  act: (key: string, fn: () => Promise<Course>) => Promise<Course | undefined>;
  canOpen: (node: LearningNode) => boolean;
  onNavigate: (node: LearningNode, edge?: Edge) => void;
  onOpenBridge: (edge: Edge) => void;
  onOpenSource: (source: Source) => void;
  notice: string;
  onNotice: (text: string) => void;
}) {
  const { contrasts } = nodeBridges(course, node);
  const edges = course.edges.filter((edge) => !edge.synthesis_link && edge.kind !== "对比");
  const incoming = resolveBridges(course, edges.filter((edge) => edge.target === node.id));
  const outgoing = resolveBridges(course, edges.filter((edge) => edge.source === node.id));
  const steps = node.steps || [];
  const stepIds = new Set(steps.map((step) => step.id));
  const shownIn = incoming.filter(isStrong), shownOut = outgoing.filter(isStrong);
  const rows = steps.map((step, index) => ({
    step, index,
    uses: shownIn.filter((item) => item.bridge.to_step === step.id),
    usedBy: shownOut.filter((item) => item.bridge.from_step === step.id),
  }));
  const loose = { uses: shownIn.filter((item) => !stepIds.has(item.bridge.to_step)), usedBy: shownOut.filter((item) => !stepIds.has(item.bridge.from_step || "")) };
  const others = [...incoming, ...outgoing].filter((item) => !isStrong(item));
  const gaps = incoming.filter((item) => isWeak(item.bridge)).length;
  // Nodes already drawn as direct links are not repeated inside a chain.
  const onScreen = new Set([node.id, ...shownIn.map((item) => item.source.id), ...shownOut.map((item) => item.target.id)]);
  const [selected, setSelected] = useState<Selected | null>(shownIn[0] ? { kind: "bridge", item: shownIn[0], side: "in" }
    : shownOut[0] ? { kind: "bridge", item: shownOut[0], side: "out" } : null);
  const empty = !shownIn.length && !shownOut.length;
  const find = () => void act("find-links", () => api.findLinks(course.id, node.id, course.revision));
  const check = (item: ResolvedBridge) => (result: "known" | "unsure", answer: string) =>
    void act("bridge-check", () => api.checkBridge(course.id, item.edge.id, item.bridge.id, result, answer));

  const byId = new Map(course.nodes.map((entry) => [entry.id, entry]));
  const prevNode = node.handoff?.prev ? byId.get(node.handoff.prev) : undefined;
  /** "I don't get this": add a to-do to the earlier node's main note, to fill in when going back there. */
  const sendBack = async (target: LearningNode, what: string, how = "") => {
    const saved = byId.get(target.id)?.personal_note || "";
    const block = `- [ ] 没弄懂：${what}（学「${node.title}」时发现）${how ? `\n  > ${how.replace(/\s+/g, " ")}` : ""}`;
    const result = await act("note-send-back", () => api.savePersonalNote(course.id, target.id, appendBlock(saved, block), saved));
    // Saving bumps the course revision, which remounts this view; the notice lives in the panel.
    if (result) onNotice(`已记到「${mainNoteTitle(target)}」的笔记，回去复习时可以对着补。`);
  };
  const isOn = (item: ResolvedBridge) => selected?.kind !== "step" && selected?.item.bridge.id === item.bridge.id;
  const week = (other: LearningNode) => other.week && other.week !== node.week ? other.week : "";
  const chip = (item: ResolvedBridge, side: "in" | "out") => {
    const other = side === "in" ? item.source : item.target;
    const state = side === "in" ? item.bridge.state?.result : undefined;
    const tag = [
      side === "in" && (item.edge.kind === "帮助理解" ? "对比着看" : item.bridge.strength === "required" ? "必须" : "建议"),
      week(other),
      state === "known" ? "测过会" : state ? "有缺口" : "",
    ].filter(Boolean).join(" · ");
    return <button key={item.bridge.id} type="button" className={cn("nl-chip", item.bridge.strength !== "required" && "is-weak", state && state !== "known" && "is-gap", isOn(item) && "is-on")}
      aria-pressed={isOn(item)} onClick={() => setSelected({ kind: "bridge", item, side })}>
      <span className="nl-chip-title"><span className={cn("nl-dot", done(other) && "is-done")} aria-label={done(other) ? "已学会" : "还没学"} />{other.title}</span>
      {tag && <span className="nl-chip-tag">{tag}</span>}
    </button>;
  };
  const small = (item: ResolvedBridge, direction: "before" | "after") => {
    const other = direction === "after" ? item.target : item.source;
    return <button key={item.bridge.id} type="button" title={week(other) || undefined}
      className={cn("nl-chip is-small", selected?.kind === "chain" && selected.item.bridge.id === item.bridge.id && "is-on")}
      onClick={() => setSelected({ kind: "chain", item, direction })}>{other.title}</button>;
  };
  // Left: the earlier knowledge each used node itself rests on, oldest first, so the row reads forward in time.
  const left = (items: ResolvedBridge[]) => items.map((item) => {
    const roots = chain(course, item.source, "before", DEPTH_BEFORE, onScreen).reverse();
    return <div key={item.bridge.id} className="nl-stack">
      {roots.length > 0 && <div className="nl-chain is-before" aria-label={`${item.source.title} 更早的基础`}>
        <span className="nl-chain-label">更早</span>
        {roots.map((root, index) => <span key={root.bridge.id} className="nl-chain-step">{index > 0 && <ArrowRight size={12} aria-hidden />}{small(root, "before")}</span>)}
        <ArrowRight size={12} aria-hidden />
      </div>}
      {chip(item, "in")}
    </div>;
  });
  // Right: where the later node is used in turn, so a link reaches the much later lessons.
  const right = (items: ResolvedBridge[]) => items.map((item) => {
    const ahead = chain(course, item.target, "after", DEPTH_AFTER, onScreen);
    return <div key={item.bridge.id} className="nl-stack">
      {chip(item, "out")}
      {ahead.length > 0 && <div className="nl-chain" aria-label={`${item.target.title} 之后还会用到`}>
        <CornerDownRight size={13} aria-hidden />
        {ahead.map((next, index) => <span key={next.bridge.id} className="nl-chain-step">{index > 0 && <ArrowRight size={12} aria-hidden />}{small(next, "after")}</span>)}
      </div>}
    </div>;
  });
  const row = (key: string, uses: ResolvedBridge[], center: React.ReactNode, usedBy: ResolvedBridge[]) => <div key={key} className="nl-row">
    <div className="nl-side is-left"><span className="nl-side-label">先要会</span>{left(uses)}</div>
    <div className={cn("nl-link", !uses.length && "is-none", uses.length && uses.every((item) => item.bridge.strength !== "required") && "is-weak")} aria-hidden />
    {center}
    <div className={cn("nl-link", !usedBy.length && "is-none", usedBy.length && usedBy.every((item) => item.bridge.strength !== "required") && "is-weak")} aria-hidden />
    <div className="nl-side is-right"><span className="nl-side-label">后面用到</span>{right(usedBy)}</div>
  </div>;

  return <section className="node-links" aria-label="前后联系">
    <div className="nl-head">
      <h3 className="t-label">前后联系{gaps > 0 && <span className="nl-gaps"> · {gaps} 块前置有缺口</span>}</h3>
      {aiEnabled && !reviewStrict && <Button size="sm" variant="ghost" disabled={busy} onClick={find}><Sparkles /> {empty ? "让 AI 找前后联系" : "让 AI 重新找"}</Button>}
    </div>
    <TaskCards kind="links" target={node.id} limit={1} />
    {notice && <p role="status" className="t-meta">{notice}</p>}
    {(node.plain || node.formal) && <div className="nl-self">
      {node.plain && <p className="nl-plain">{node.plain}</p>}
      {node.formal && <p className="nl-formal">{node.formal}</p>}
    </div>}

    <Handoff course={course} node={node} canOpen={canOpen} onNavigate={onNavigate}
      onShow={(item, side) => isStrong(item) ? setSelected({ kind: "bridge", item, side }) : onOpenBridge(item.edge)} />

    {empty ? <p className="nl-empty">
      {others.length ? `这一课有 ${others.length} 条联系，但还没写清具体用到哪一块。` : "这一课还没有整理出前后联系。"}
      {reviewStrict ? "退出所选资料复习后，可以让 AI 按整门课重新找。"
        : aiEnabled ? "点「让 AI 找前后联系」，AI 会按整门课找出它真正建立在哪些之前的知识上，以及很后面哪些课还会用到它。" : "在设置中打开 AI 后可以自动整理。"}
    </p> : <>
      <div className="nl-grid">
        <div className="nl-row is-head" aria-hidden><span className="nl-side is-left">先要会（及更早的基础）</span><span /><span>这一课的每一步</span><span /><span className="nl-side is-right">后面用到它（及更后面）</span></div>
        {rows.map(({ step, index, uses, usedBy }) => row(step.id, uses, <button type="button"
          className={cn("nl-step", selected?.kind === "step" && selected.step.id === step.id && "is-on")}
          onClick={() => setSelected({ kind: "step", step, index })}><span className="nl-num">{index + 1}</span>{step.title}</button>, usedBy))}
        {(loose.uses.length > 0 || loose.usedBy.length > 0) && row("loose", loose.uses,
          <div className="nl-step is-loose">{steps.length ? "整体（没对到具体一步）" : "这一课整体"}</div>, loose.usedBy)}
      </div>
      <div className="nl-legend">
        <span><i className="is-strong" />直接用到</span><span><i className="is-weak" />建议 / 对比着看</span><span>小字是沿必需联系继续往前、往后追到的知识点</span>
      </div>
      {selected && <Detail key={selected.kind === "step" ? selected.step.id : selected.item.bridge.id} selected={selected} busy={busy}
        canOpen={canOpen} onNavigate={onNavigate} onOpenBridge={onOpenBridge} onOpenSource={onOpenSource} onCheck={check}
        backTo={selected.kind === "step"
          ? (() => { const uses = rows[selected.index]?.uses.map((item) => item.source) || []; return uses.length ? uses : prevNode ? [prevNode] : []; })()
          : (selected.kind === "bridge" ? selected.side === "in" : selected.direction === "before") ? [selected.item.source] : []}
        onSendBack={(target, what, how) => void sendBack(target, what, how)} />}
    </>}

    {(others.length > 0 || contrasts.length > 0) && <details className="nl-more">
      <summary>其他联系 {others.length + contrasts.length} 条（拓展、还没写清的、容易混淆的）</summary>
      <div className="nl-more-list">
        {others.map((item) => {
          const incomingItem = item.target.id === node.id;
          const other = incomingItem ? item.source : item.target;
          return <button key={item.bridge.id} type="button" className="nl-more-item" onClick={() => onOpenBridge(item.edge)}>
            <span>{incomingItem ? "先要会" : "后面用到"} · <b>{other.title}</b></span>
            <span className="t-meta">{item.bridge.legacy ? "还没写清用到哪一块" : `${STRENGTH_LABEL[item.bridge.strength]} · ${pieceLabel(item)}`}</span>
          </button>;
        })}
        {contrasts.map((edge) => {
          const other = course.nodes.find((entry) => entry.id === (edge.source === node.id ? edge.target : edge.source));
          return other && <button key={edge.id} type="button" className="nl-more-item" onClick={() => onOpenBridge(edge)}>
            <span>容易混淆 · <b>{node.title} ↔ {other.title}</b></span>
          </button>;
        })}
      </div>
    </details>}
  </section>;
}

/**
 * 承上启下: the lesson just before and just after this one in the learning order, each with how it
 * connects. A bridge between the two means it is really used (直接用到); otherwise they are only
 * next to each other in the order (顺序衔接) and the AI's transition says why.
 */
function Handoff({ course, node, canOpen, onNavigate, onShow }: {
  course: Course; node: LearningNode; canOpen: (node: LearningNode) => boolean;
  onNavigate: (node: LearningNode, edge?: Edge) => void;
  onShow: (item: ResolvedBridge, side: "in" | "out") => void;
}) {
  const handoff = node.handoff;
  const byId = new Map(course.nodes.map((entry) => [entry.id, entry]));
  const prev = handoff?.prev ? byId.get(handoff.prev) : undefined;
  const next = handoff?.next ? byId.get(handoff.next) : undefined;
  if (!handoff || (!prev && !next)) return null;
  const between = (other: LearningNode) => resolveBridges(course, course.edges.filter((edge) => !edge.synthesis_link && edge.kind !== "对比"
    && ((edge.source === other.id && edge.target === node.id) || (edge.source === node.id && edge.target === other.id))))
    .find((item) => !item.bridge.legacy);
  const row = (other: LearningNode, side: "prev" | "next") => {
    const item = between(other);
    const text = (side === "prev" ? handoff.prev_text : handoff.next_text) || item?.bridge.how || "";
    const state = item?.target.id === node.id ? item.bridge.state?.result : undefined;
    const open = canOpen(other);
    return <div className="nl-hand-row">
      <span className={cn("nl-hand-dot", done(other) ? "is-done" : !other.unlocked && "is-locked")} aria-label={done(other) ? "已学会" : other.unlocked ? "还没学" : "还没解锁"} />
      <div className="min-w-0">
        <div className="nl-hand-top">
          <span className="nl-hand-kicker">{side === "prev" ? "← 上一课" : "下一课 →"}</span>
          {open ? <button type="button" className="nl-hand-title" onClick={() => onNavigate(other)}>{other.title}</button>
            : <span className="nl-hand-title">{other.title}</span>}
          {other.week && other.week !== node.week && <span className="nl-hand-week">{other.week}</span>}
          <span className={cn("nl-hand-tag", item ? "is-use" : "is-seq")}>{item ? "直接用到" : "顺序衔接"}</span>
        </div>
        <p className={cn("nl-hand-say", !text && "is-empty")}>{text || "还没写衔接。点上方「让 AI 重新找」会一起写好。"}</p>
        <p className="nl-hand-more">
          {item && <>{STRENGTH_LABEL[item.bridge.strength]}{state === "known" ? " · 你已测过会" : state ? " · 有缺口" : ""}
            <button type="button" onClick={() => onShow(item, item.target.id === node.id ? "in" : "out")}>看这条联系</button></>}
          {!item && text && "AI 写的过渡"}
          {!open && `${item || text ? " · " : ""}${side === "next" ? "还没解锁，学完这一课后可打开" : "还没解锁"}`}
        </p>
      </div>
    </div>;
  };
  return <div className="nl-hand-wrap">
    <div className="nl-hand-label">承上启下{handoff.line_name && ` · 主线「${handoff.line_name}」`}</div>
    <div className="nl-hand">
      {prev && row(prev, "prev")}
      <div className="nl-hand-row is-me">
        <span className="nl-hand-dot is-me" aria-hidden />
        <div className="nl-hand-top"><span className="nl-hand-kicker">这一课</span><span className="nl-hand-title">{node.title}</span>
          {node.week && <span className="nl-hand-week">{node.week}</span>}</div>
      </div>
      {next && row(next, "next")}
    </div>
  </div>;
}

function Detail({ selected, busy, canOpen, onNavigate, onOpenBridge, onOpenSource, onCheck, backTo, onSendBack }: {
  selected: Selected; busy: boolean; canOpen: (node: LearningNode) => boolean;
  onNavigate: (node: LearningNode, edge?: Edge) => void; onOpenBridge: (edge: Edge) => void;
  onOpenSource: (source: Source) => void;
  onCheck: (item: ResolvedBridge) => (result: "known" | "unsure", answer: string) => void;
  /** Earlier nodes this piece rests on; "不会" adds a to-do to their notes. */
  backTo: LearningNode[];
  onSendBack: (target: LearningNode, what: string, how?: string) => void;
}) {
  const what = selected.kind === "step" ? `第 ${selected.index + 1} 步「${selected.step.title}」`
    : selected.item.piece ? `「${selected.item.piece.title}」` : `「${selected.item.source.title}」在这里怎么用`;
  const how = selected.kind === "step" ? selected.step.formal : selected.item.bridge.how;
  const back = backTo.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-2">
    <span className="t-meta">这里不会？</span>
    {backTo.map((target) => <Button key={target.id} size="sm" variant="outline" disabled={busy}
      title={`在「${target.title}」的主笔记末尾加一条待办，回去复习时补上`}
      onClick={() => onSendBack(target, what, how)}><NotebookPen /> 记到「{target.title}」的笔记</Button>)}
  </div>;
  if (selected.kind === "step") {
    return <div className="nl-detail">
      <strong className="nl-detail-title">第 {selected.index + 1} 步 · {selected.step.title}</strong>
      <Words formal={selected.step.formal} />
      {back}
    </div>;
  }
  const { item } = selected;
  const incoming = selected.kind === "bridge" ? selected.side === "in" : selected.direction === "before";
  const other = incoming ? item.source : item.target;
  const ownStep = item.source.steps?.findIndex((step) => step.id === item.bridge.from_step) ?? -1;
  const line = selected.kind === "chain"
    ? selected.direction === "after"
      ? `接在「${item.source.title}」后面：${item.bridge.how}`
      : `「${item.target.title}」用到它${item.piece ? `的「${item.piece.title}」` : ""}：${item.bridge.how}`
    : incoming
      ? `${item.stepNumber ? `用在这一课第 ${item.stepNumber} 步` : "用在这一课"}${item.piece ? `，用到它的「${item.piece.title}」` : ""}：${item.bridge.how}`
      : `${ownStep >= 0 ? `建立在这一课第 ${ownStep + 1} 步上` : "建立在这一课上"}${item.step ? `，用于它的「${item.step.title}」` : ""}：${item.bridge.how}`;
  return <div className="nl-detail">
    <div className="flex items-start gap-2">
      <strong className="nl-detail-title min-w-0 flex-1">{other.title}{other.week && <span className="t-meta font-normal"> · {other.week}</span>}</strong>
      {canOpen(other) && <Button size="sm" variant="ghost" onClick={() => onNavigate(other, item.edge)}>{incoming ? "去复习它" : "打开"} <ArrowUpRight /></Button>}
    </div>
    <p className="nl-how">{line}</p>
    <Words plain={other.plain} formal={other.formal} />
    {selected.kind === "bridge" && incoming && <BridgeCheck item={item} busy={busy} onCheck={onCheck(item)} onOpenSource={onOpenSource} />}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {item.bridge.origin !== "user" && <span className="t-meta">{item.bridge.sources?.length ? `AI 写的 · 有 ${item.bridge.sources.length} 处材料原文` : "AI 写的 · 材料里没找到原文依据"}</span>}
      <Button size="sm" variant="ghost" onClick={() => onOpenBridge(item.edge)}>看这条联系的详情</Button>
    </div>
    {back}
  </div>;
}

function Words({ plain, formal }: { plain?: string; formal?: string }) {
  if (!plain && !formal) return <p className="t-meta mt-2">还没有大白话和正式说法；点上方「让 AI 重新找」会一起写好。</p>;
  return <>
    {plain && <><div className="nl-k">大白话</div><p>{plain}</p></>}
    {formal && <><div className="nl-k">正式说法</div><p className="nl-formal">{formal}</p></>}
  </>;
}
