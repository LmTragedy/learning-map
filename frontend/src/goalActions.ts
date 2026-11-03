import { createContext, useContext } from "react";
import type { GoalChange } from "./goalContext";

/** App-level goal actions for the node panel's goal card, provided without threading props through NodePanel. */
export type GoalActions = {
  focusedGoal: string;
  onFocusGoal: (goalId: string) => void;
  onOpenNode: (nodeId: string) => void;
  changes: GoalChange[];
  onDismissChanges: () => void;
};

export const GoalActionsContext = createContext<GoalActions | null>(null);

export const useGoalActions = () => useContext(GoalActionsContext);
