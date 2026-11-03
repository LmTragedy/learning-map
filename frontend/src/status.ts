import { BadgeCheck, BookOpen, CircleCheck, CircleDot, Lock } from "lucide-react";

// Display words for node states; the stored values (new / studied / mastered / passed) never change.
export const statusLabel = { passed: "验收通过", mastered: "自我掌握", studied: "学过", new: "可学习", locked: "未解锁" } as const;
export const statusIcon = { passed: CircleCheck, mastered: BadgeCheck, studied: BookOpen, new: CircleDot, locked: Lock } as const;

