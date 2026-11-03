import type { LearningNode } from "./types";

export function isNodeVisible(node: LearningNode, options: { reviewActive: boolean; directEntryId?: string; directWeek?: string }) {
  return options.reviewActive || node.unlocked || node.id === options.directEntryId
    || Boolean(options.directWeek && node.week === options.directWeek);
}
