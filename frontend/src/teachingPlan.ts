import type { TeachingPlan } from "./types";

export type PlanState = { key: "none" | "current" | "stale" | "review"; label: string; hint: string };

const reasons = (plan: TeachingPlan) =>
  plan.uncertain_reasons?.length ? `${plan.uncertain_reasons.join("；")}。` : "依据存疑，请对照来源核对。";

/**
 * How a node's teaching plan should be read right now. Anything that needs a look outranks a plain
 * version label: conflicts first, then staleness, then a candidate plan or one with shaky evidence.
 */
export function planState(plan: TeachingPlan | null | undefined): PlanState {
  if (!plan) return { key: "none", label: "未准备", hint: "小课按知识块和相关节点的职责生成；准备分工后可以按本节任务讲得更准。" };
  if (plan.conflicts.length) return { key: "review", label: `${plan.conflicts.length} 处待核对`, hint: `冲突涉及的知识块仍保留在本节，生成小课时照常讲解。${plan.uncertain ? reasons(plan) : ""}` };
  if (plan.status === "stale") return { key: "stale", label: "已过期", hint: "本节点或相关节点的内容已变化；小课和对话暂不使用这份分工，按知识块讲解，可以更新分工。" };
  if (plan.candidate) return { key: "review", label: "候选", hint: `本节点没有知识块，这是依据目标和来源提出的候选分工。${reasons(plan)}` };
  if (plan.uncertain) return { key: "review", label: `第 ${plan.version} 版 · 待核对`, hint: reasons(plan) };
  return { key: "current", label: `第 ${plan.version} 版`, hint: "" };
}

/** The node titles a conflict names, other than this node, for display. */
export function conflictTitles(conflict: TeachingPlan["conflicts"][number], titles: Map<string, string>, self: string) {
  return conflict.node_ids.filter((id) => id !== self).map((id) => titles.get(id) ?? "已删除的知识点");
}
