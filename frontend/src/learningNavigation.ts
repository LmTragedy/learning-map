import type { Course } from "./types";

export function recommendedNode(course: Course, eligibleNodes = course.nodes) {
  return eligibleNodes.find((node) => node.id === course.route?.next_node_id)
    ?? eligibleNodes.find((node) => node.unlocked && node.status !== "passed" && node.status !== "mastered")
    ?? eligibleNodes[0];
}
