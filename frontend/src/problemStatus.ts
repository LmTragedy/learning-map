import type { Course, Problem, ProblemSet } from "./types";

export type ProblemStatus = "new" | "passed" | "failed" | "uncertain";

export const STATUS_LABEL: Record<ProblemStatus, string> = { new: "未练", passed: "已通过", failed: "需补充", uncertain: "待确认" };

export const problemRef = (set: ProblemSet, problem: Problem) => `${set.id}/${problem.id}`;

/** Latest practice result of each real problem, across all nodes; the learner's decision wins over the AI's. */
export function problemStatuses(course: Course): Map<string, ProblemStatus> {
  const latest = new Map<string, { at: string; status: ProblemStatus }>();
  for (const node of course.nodes) {
    for (const attempt of node.attempts) {
      const ref = attempt.question?.problem_ref;
      if (!ref) continue;
      const at = (attempt as { created_at?: string }).created_at ?? "";
      const status: ProblemStatus = attempt.resolution
        ? attempt.resolution === "supplement" ? "failed" : "passed"
        : attempt.judgment.outcome === "passed" ? "passed" : attempt.judgment.outcome === "failed" ? "failed" : "uncertain";
      const previous = latest.get(ref);
      if (!previous || at >= previous.at) latest.set(ref, { at, status });
    }
  }
  return new Map([...latest].map(([ref, value]) => [ref, value.status]));
}

export type NodeProblem = { set: ProblemSet; problem: Problem; status: ProblemStatus };

/** Problems linked to one knowledge node, real ones first. */
export function nodeProblems(course: Course, nodeId: string, statuses = problemStatuses(course)): NodeProblem[] {
  return (course.problem_sets || []).flatMap((set) => set.problems.filter((problem) => problem.node_ids.includes(nodeId))
    .map((problem) => ({ set, problem, status: statuses.get(problemRef(set, problem)) || "new" as ProblemStatus })))
    .sort((a, b) => Number(a.set.origin === "ai") - Number(b.set.origin === "ai"));
}

/** Per node: how many linked problems, and how many of them passed. */
export function problemSummary(course: Course): Map<string, { total: number; passed: number }> {
  const statuses = problemStatuses(course);
  const summary = new Map<string, { total: number; passed: number }>();
  for (const set of course.problem_sets || []) for (const problem of set.problems) for (const nodeId of problem.node_ids) {
    const entry = summary.get(nodeId) || { total: 0, passed: 0 };
    entry.total += 1;
    if (statuses.get(problemRef(set, problem)) === "passed") entry.passed += 1;
    summary.set(nodeId, entry);
  }
  return summary;
}
