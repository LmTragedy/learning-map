import type { Course, Goal, LearningNode } from "./types";

export type NodeGoalRole = "endpoint" | "route" | "subtask";

export type NodeGoalContext = {
  goal: Goal;
  roles: NodeGoalRole[];
  /** Full route to the goal's end stations, prerequisites first, finished nodes included. */
  path: string[];
  /** 1-based position of the node on the path; 0 when it is only linked through a subtask. */
  step: number;
  completed: number;
  /** Route nodes still to finish, the current node included. */
  remaining: number;
  /** Subtasks this node's verification will tick (or already ticked). */
  subtasks: Goal["subtasks"];
  next?: LearningNode;
};

const STATUS_ORDER = { doing: 0, todo: 1, done: 2 } as const;

/** Same rule as the backend goal route: mastered or passed counts as finished. */
export const finished = (node: LearningNode) => node.status === "mastered" || node.status === "passed";

/** Ancestors of the end stations in prerequisite order (each node after everything it depends on). */
export function goalPath(course: Course, endIds: string[]) {
  const nodes = new Map(course.nodes.map((node) => [node.id, node]));
  const path: string[] = [], seen = new Set<string>();
  const visit = (id: string) => {
    const node = nodes.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    node.prerequisites.forEach(visit);
    path.push(id);
  };
  endIds.forEach(visit);
  return path;
}

/** Every goal the node belongs to, as an end station, a route step or a subtask; active goals first. */
export function goalsForNode(course: Course, nodeId: string): NodeGoalContext[] {
  const nodes = new Map(course.nodes.map((node) => [node.id, node]));
  const roleRank = (roles: NodeGoalRole[]) => roles.includes("endpoint") ? 0 : roles.includes("route") ? 1 : 2;
  return (course.goals || []).flatMap((goal) => {
    const path = goalPath(course, goal.node_ids);
    const subtasks = (goal.subtasks || []).filter((task) => task.node_id === nodeId);
    const roles: NodeGoalRole[] = [];
    if (goal.node_ids.includes(nodeId)) roles.push("endpoint");
    else if (path.includes(nodeId)) roles.push("route");
    if (subtasks.length) roles.push("subtask");
    if (!roles.length) return [];
    const open = path.map((id) => nodes.get(id)!).filter((node) => !finished(node));
    const others = open.filter((node) => node.id !== nodeId);
    return [{
      goal, roles, path, subtasks,
      step: path.indexOf(nodeId) + 1,
      completed: path.length - open.length,
      remaining: open.length,
      next: others.find((node) => node.unlocked) || others[0],
    }];
  }).sort((a, b) => STATUS_ORDER[a.goal.status] - STATUS_ORDER[b.goal.status] || roleRank(a.roles) - roleRank(b.roles));
}

export type GoalChange = { goalId: string; title: string; verified?: [number, number]; total: number; subtasks: string[] };

/** What moved in each goal between two reads of the same course; empty when nothing changed. */
export function goalProgressDiff(before: Course, after: Course): GoalChange[] {
  const previous = new Map((before.goals || []).map((goal) => [goal.id, goal]));
  return (after.goals || []).flatMap((goal) => {
    const old = previous.get(goal.id);
    if (!old) return [];
    const was = old.progress?.verified || 0, now = goal.progress?.verified || 0;
    const ticked = new Set((old.subtasks || []).filter((task) => task.done || task.auto_done).map((task) => task.id));
    const subtasks = (goal.subtasks || []).filter((task) => (task.done || task.auto_done) && !ticked.has(task.id)).map((task) => task.title);
    if (was === now && !subtasks.length) return [];
    return [{ goalId: goal.id, title: goal.title, verified: was === now ? undefined : [was, now], total: goal.node_ids.length, subtasks }];
  });
}
