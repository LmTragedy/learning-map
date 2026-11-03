export type NodeStatus = "new" | "studied" | "mastered" | "passed";
export const RELATION_KINDS = ["前置知识", "帮助理解", "工具关系", "相似或对比", "归纳关系"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export type Attempt = {
  id: string;
  question: { prompt: string; kind: string; rubric: string };
  answer: string;
  reference: string;
  attachments: Material[];
  judgment: {
    outcome: "passed" | "failed" | "uncertain";
    reasoning: string;
    blockers: string[];
    next_step: string;
  };
  resolution?: string;
  rating_state: "pending" | "submitted" | "skipped";
  created_at: string;
};
export type Chat = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};
export type RecallSummary = {
  title: string;
  items: {
    category:
      | "学习起点"
      | "用户想法"
      | "知识连接"
      | "当前进展"
      | "待继续"
      | "AI推测";
    content: string;
    evidence_ids: string[];
  }[];
  uncertainties: string[];
  messages: Chat[];
  created_at: string;
  history_revision: number;
};
export type Material = {
  id: string;
  name: string;
  week: string;
  kind: string;
  sha256: string;
  pages: {
    number: number;
    text: string;
    method: string;
    uncertain: boolean;
    warnings: string[];
  }[];
  warnings: string[];
};
export type LearningNode = {
  id: string;
  personal_note?: string;
  personal_note_title?: string;
  kind?: "concept" | "synthesis" | string;
  related_node_ids?: string[];
  relation_id?: string;
  title: string;
  summary: string;
  week: string;
  sources: { material_id: string; page: number; quote: string }[];
  prerequisites: string[];
  status: NodeStatus;
  verification: "none" | "ai_passed" | "user_passed" | "review";
  review_verification?: "none" | "ai_passed" | "user_passed" | "review";
  uncertain: boolean;
  material_variants?: { summary: string; sources: { material_id: string; page: number; quote: string }[]; uncertain: true }[];
  difficulty: string;
  chats: Chat[];
  attempts: Attempt[];
  question?: { prompt: string; kind: string; rubric: string };
  thread_id?: string;
  unlocked: boolean;
  lessons?: Lesson[];
  review_archived?: { chats: number; attempts: number; lessons: number };
};
export type Lesson = {
  id: string;
  title: string;
  goal: string;
  recap: string;
  check_question: string;
  check_answer: string;
  kind: "initial" | "supplement";
  focus: string;
  created_at: string;
  read_at: string | null;
};
export type LearningRoute = {
  stages: { id: string; title: string; node_ids: string[] }[];
  next_node_id: string | null;
  next_for_goal?: boolean;
  completed_count: number;
  total: number;
  warning: string;
};
export type GoalFields = {
  title: string;
  description: string;
  kind: "course" | "personal";
  status: "todo" | "doing" | "done";
  node_ids: string[];
  subtasks: { id: string; title: string; done: boolean; node_id?: string; auto_done?: boolean }[];
};
export type Goal = GoalFields & {
  id: string;
  created_at: string;
  sources: { material_id: string; page: number; quote: string }[];
  progress: { linked: number; studied: number; mastered: number; verified: number; review: number; subtasks_done: number; subtasks_total: number };
};
export type GoalPreview = {
  token: string;
  revision: number;
  goals: { title: string; description: string; node_ids: string[]; subtasks: string[]; sources: Goal["sources"] }[];
};
/** A named note of its own, bound to one or more nodes (the node's main note lives on the node). */
export type CourseNote = {
  id: string;
  title: string;
  node_ids: string[];
  content: string;
  created_at: string;
  updated_at: string;
};

export type Course = {
  id: string;
  title: string;
  revision: number;
  created_at: string;
  materials: Material[];
  nodes: LearningNode[];
  goals?: Goal[];
  notes?: CourseNote[];
  edges: {
    id: string;
    source: string;
    target: string;
    relation: string;
    uncertain: boolean;
    explanation?: string;
    when_to_use?: string;
    basis?: string;
    evidence_kind?: "material_quote" | "material_inference" | "ai_inference" | string;
    sources?: { material_id: string; page: number; quote: string }[];
    confirmed?: boolean;
    forward_difficulty?: string;
    reverse_difficulty?: string;
    presentation?: "simple" | "synthesis";
    synthesis_node_id?: string;
    controls_unlock?: boolean;
    synthesis_link?: boolean;
    origin_relation_id?: string;
    related_node_ids?: string[];
  }[];
  ratings: unknown[];
  suggestions: { id: string; [key: string]: unknown }[];
  preferences: { pace: string };
  route?: LearningRoute;
  review_scope: {
    enabled: boolean;
    material_ids: string[];
    ai_scope: "selected" | "course";
    key: string;
    node_ids: string[];
  };
};
export type CourseSummary = {
  id: string;
  title: string;
  node_count: number;
  passed_count: number;
  material_count: number;
  revision: number;
};
export type Profile = {
  courses: unknown[];
  ratings_count: number;
  stages: {
    id: string;
    count: number;
    problem_average: number | null;
    mastery_average: number | null;
    advice: string;
    accepted: boolean;
    basis?: string;
    ratings?: {
      course_title?: string;
      node_id?: string;
      problem: number | null;
      mastery: number | null;
      comment: string;
      created_at: string;
    }[];
  }[];
  suggestions: { id: string; [key: string]: unknown }[];
};
export type Settings = {
  ai_enabled: boolean;
  model: string;
  note_review_model: string;
  reasoning_effort: "low" | "medium" | "high";
  obsidian_vault: string;
  parser: string;
  [key: string]: unknown;
};
export type Preview = {
  token: string;
  target: string;
  contents?: string[];
  content?: string;
  warning: string;
};
