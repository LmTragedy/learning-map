export type NodeStatus = "new" | "studied" | "mastered" | "passed";
export const PIECE_KINDS = ["定义", "记号", "性质", "方法", "例子"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];
export type Strength = "required" | "suggested" | "extension";
/** A check or practice result for one bridge: "missing" is written only by a failed practice. */
export type BridgeState = { result: "known" | "unsure" | "missing"; at: string; via: "check" | "attempt"; answer?: string } | null;
export type Piece = { id: string; kind: PieceKind; title: string; detail: string; sources?: Source[]; uncertain?: boolean; state?: BridgeState };
/** `formal` is the course's formal statement of the step, written by the links AI. */
export type Step = { id: string; title: string; formal?: string };
export type Bridge = {
  id: string;
  from_piece: string;
  to_step: string;
  how: string;
  if_missing: string;
  strength: Strength;
  check: { question: string; answer: string };
  sources: Source[];
  uncertain: boolean;
  origin: "migrated" | "ai" | "user";
  legacy?: boolean;
  /** On a link to a later node: which step of the earlier node it builds on. */
  from_step?: string;
  state?: BridgeState;
};
export type Source = { material_id: string; page: number; quote: string };
/** A main line: an ordered chain of nodes that together answer one larger question. */
export type Line = {
  id: string;
  name: string;
  goal: string;
  node_ids: string[];
  endpoint: string;
  story: { node_id: string; text: string }[];
  retells?: { id: string; at: string; text: string; review: { covered: string[]; missing: { node_id: string; note: string }[]; feedback: string } }[];
  origin: "ai" | "user";
  color: number;
  progress: { done: number; total: number; ratio?: number; nodes?: { done: number; total: number } };
};
export const RELATION_KINDS = ["前置知识", "帮助理解", "工具关系", "相似或对比", "归纳关系"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export type Attempt = {
  id: string;
  question: { prompt: string; kind: string; rubric: string; images?: string[]; answer_images?: string[]; problem_ref?: string };
  answer: string;
  reference: string;
  attachments: Material[];
  judgment: {
    outcome: "passed" | "failed" | "uncertain";
    reasoning: string;
    blockers: string[];
    next_step: string;
    missing_bridges?: string[];
  };
  resolution?: string;
  rating_state: "pending" | "submitted" | "skipped";
  created_at: string;
  parent_attempt_id?: string | null;
  question_key?: string;
};
export type PracticeProgress = {
  question_key: string;
  attempt_ids: string[];
  confirmed_points: { id: string; point: string; attempt_id: string; quote: string }[];
  blockers: string[];
  markdown: string;
} | null;
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
  progress?: { known: number; total: number; ratio: number; done: boolean };
  pieces?: Piece[];
  steps?: Step[];
  /** One plain-language sentence and the formal statement, written by the links AI. */
  plain?: string;
  formal?: string;
  /** The lessons just before and after, in the side list's order, with the links AI's transition for each. */
  handoff?: { line_name: string; prev: string | null; next: string | null; prev_text: string; next_text: string };
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
  practice_progress?: PracticeProgress;
  /** images: "setId/imageId" screenshots of a real problem. */
  question?: { prompt: string; kind: string; rubric: string; images?: string[]; answer_images?: string[]; problem_ref?: string };
  thread_id?: string;
  unlocked: boolean;
  lessons?: Lesson[];
  /** Knowledge-piece titles that none of the saved lessons mentions (computed by the server). */
  lesson_gaps?: string[];
  review_archived?: { chats: number; attempts: number; lessons: number };
};
export type Lesson = {
  request_id?: string;
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
  route_ids?: string[];
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
  anchor?: { kind: "bridge" | "line"; id: string };
  id: string;
  title: string;
  node_ids: string[];
  content: string;
  created_at: string;
  updated_at: string;
};

export type ProblemImage = { id: string; name: string; width: number; height: number };

export type Problem = {
  id: string;
  number: string;
  text: string;
  answer: string;
  /** The one main node this problem belongs to (practice and progress count there). */
  node_ids: string[];
  /** Nodes that only use this problem as a reference when AI writes their questions. */
  related_node_ids?: string[];
  /** What it tests, "中文 / English", written by AI when linking; used to find content-close nodes. */
  key_points?: string[];
  /** HD screenshots of the problem (cut from the PDF, pasted or framed by hand). */
  images?: ProblemImage[];
  answer_images?: ProblemImage[];
  /** Where a PDF-cut problem came from, so it can be framed again. */
  file_id?: string;
  pages?: number[];
  /** AI unit problems only. */
  kind?: string;
  sources?: { material_id: string; page: number }[];
  benchmark_ids?: string[];
};

export type ProblemSet = {
  id: string;
  title: string;
  /** real: imported by the learner; ai: generated to the standard of real sets. */
  origin: "real" | "ai";
  created_at: string;
  files: { id: string; name: string; kind: string; role?: "problem" | "answer"; page_count?: number }[];
  problems: Problem[];
  /** Shared instructions printed before problem 1. */
  instructions?: string;
  standard?: string;
  basis?: { material_ids: string[]; problem_set_ids: string[]; focus: string };
};

export type Course = {
  id: string;
  title: string;
  revision: number;
  created_at: string;
  materials: Material[];
  /** Pages with text, and how many carry the full material index. */
  material_index?: { indexed: number; total: number };
  nodes: LearningNode[];
  goals?: Goal[];
  problem_sets?: ProblemSet[];
  notes?: CourseNote[];
  lines?: Line[];
  overview?: { summary: string; abilities: string[] };
  progress?: { pieces: { known: number; total: number }; nodes: { done: number; total: number }; ratio?: number };
  /** Nodes on two or more lines. */
  transfers?: string[];
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
    /** Learner-facing kind projected by the server. */
    kind?: "用到" | "推广" | "对比" | "帮助理解" | "综合";
    bridges?: Bridge[];
    strength?: Strength | null;
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
  goal_model: string;
  deepseek_key_set?: boolean;
  deepseek_api_key?: string;
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

