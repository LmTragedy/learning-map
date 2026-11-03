import type { Goal, GoalFields } from "./types";

export const emptyGoal: GoalFields = {
  title: "", description: "", kind: "course", status: "todo", node_ids: [], subtasks: [],
};

export function editableGoal(goal: GoalFields): GoalFields {
  return {
    title: goal.title, description: goal.description || "", kind: goal.kind || "course", status: goal.status,
    node_ids: goal.node_ids, subtasks: goal.subtasks || [],
  };
}

/** All linked nodes verified and every subtask ticked; the user still confirms. */
export function readyToFinish(goal: Goal) {
  const progress = goal.progress;
  if (goal.status === "done" || !progress) return false;
  const nodesDone = !goal.node_ids.length || progress.verified >= goal.node_ids.length;
  const tasksDone = progress.subtasks_done >= progress.subtasks_total;
  return nodesDone && tasksDone && (goal.node_ids.length > 0 || progress.subtasks_total > 0);
}
