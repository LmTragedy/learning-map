import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  CircleHelp,
  Clock3,
  FilePlus2,
  FileSearch,
  FolderOpen,
  LoaderCircle,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  BookMarked,
  Bot,
  BotOff,
  CalendarDays,
  ChevronDown,
  Ellipsis,
  GraduationCap,
  History,
  Layers,
  Library,
  LogOut,
  Map as MapIcon,
  Menu,
  MousePointerClick,
  NotebookPen,
  Pencil,
  Save,
  Search,
  Sparkles,
  FileText,
  Waypoints,
  Target,
} from "lucide-react";
import { api, materialFileUrl } from "./api";
import { cn } from "./lib/utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { CourseMap } from "./CourseMap";
import { recommendedNode } from "./learningNavigation";
import { isRelationVisible } from "./relationVisibility";
import { NodePanel } from "./NodePanel";
import { GoalBoard } from "./GoalBoard";
import { GoalActionsContext } from "./goalActions";
import { goalProgressDiff, goalsForNode, type GoalChange } from "./goalContext";
import { needsBridges } from "./bridges";
import { LinesPanel } from "./LinesPanel";
import { CourseNotes } from "./CourseNotes";
import { hasUnsavedNotes } from "./noteDrafts";
import { hasVolatileAnswerDrafts } from "./answerDrafts";
import { RecallPanel } from "./RecallPanel";
import type {
  Course,
  CourseSummary,
  LearningNode,
  Preview,
  Profile,
  RecallSummary,
  Settings,
} from "./types";

type Modal =
  | "create"
  | "import"
  | "settings"
  | "profile"
  | "versions"
  | "obsidian"
  | "restore"
  | "delete"
  | "recall"
  | "review"
  | "materials"
  | "goals"
  | "lines"
  | "course-notes"
  | null;
export function App() {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [course, setCourse] = useState<Course | null>(null);
  const [selected, setSelected] = useState<LearningNode>();
  const [noteTarget, setNoteTarget] = useState("");
  const [noteRequest, setNoteRequest] = useState(0);
  const [noteTargetId, setNoteTargetId] = useState("");
  const [goalChatTarget, setGoalChatTarget] = useState("");
  const [goalFocus, setGoalFocus] = useState("");
  const [explainHidden, setExplainHidden] = useState(false);
  const [lineFocus, setLineFocus] = useState("");
  const [mapGoal, setMapGoal] = useState("");
  const [goalChanges, setGoalChanges] = useState<{ courseId: string; changes: GoalChange[] }>();
  // Compare each new read of the course with the last one to surface goal progress where the learner is.
  const [goalBaseline, setGoalBaseline] = useState<Course | null>(null);
  if (course !== goalBaseline) {
    const changes = course && goalBaseline?.id === course.id && goalBaseline.revision < course.revision ? goalProgressDiff(goalBaseline, course) : [];
    if (changes.length) setGoalChanges({ courseId: course!.id, changes });
    setGoalBaseline(course);
  }
  const [activeRelationId, setActiveRelationId] = useState("");
  const [relationContextNodeId, setRelationContextNodeId] = useState("");
  const [relationBackStack, setRelationBackStack] = useState<{ nodeId: string; scopeKey: string }[]>([]);
  const [health, setHealth] = useState<{
    ai: { available: boolean; reason?: string };
    parser: Record<string, unknown>;
    data_dir: string;
  }>();
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<Settings>();
  const [aiEnabled, setAiEnabled] = useState(false);
  const [profile, setProfile] = useState<Profile>();
  const [versions, setVersions] = useState<
    Awaited<ReturnType<typeof api.versions>>
  >([]);
  const [preview, setPreview] = useState<Preview>();
  const [title, setTitle] = useState("");
  const [week, setWeek] = useState("");
  const [parser, setParser] = useState("basic");
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [notePath, setNotePath] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [noteQuery, setNoteQuery] = useState("");
  const [notes, setNotes] = useState<{ path: string; content: string }[]>([]);
  const [recall, setRecall] =
    useState<Awaited<ReturnType<typeof api.recall>>>();
  const [directWeek, setDirectWeek] = useState("");
  const [directNodeId, setDirectNodeId] = useState("");
  const [directQuery, setDirectQuery] = useState("");
  const [reviewMaterialIds, setReviewMaterialIds] = useState<string[]>([]);
  const [reviewAiScope, setReviewAiScope] = useState<"selected" | "course">("selected");
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [contentContainer, setContentContainer] = useState<HTMLDivElement | null>(null);

  const loadCourses = useCallback(async (active?: string) => {
    try {
      const list = await api.courses();
      setCourses(list);
      const chosen = list.find((c) => c.id === active) || list[0];
      if (!chosen) {
        setCourse(null);
        setSelected(undefined);
        return;
      }
      const full = await api.course(chosen.id);
      setCourse(full);
      setSelected(
        (old) => full.nodes.find((n) => n.id === old?.id) || recommendedNode(full),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "读取课程失败");
    }
  }, []);
  useEffect(() => {
    void Promise.all([api.health(), api.courses(), api.settings()])
      .then(async ([status, list, preferences]) => {
        setHealth(status);
        setSettings(preferences);
        setAiEnabled(preferences.ai_enabled);
        setCourses(list);
        const first = list[0];
        if (first) {
          const full = await api.course(first.id);
          setCourse(full);
          setSelected(recommendedNode(full));
        }
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        const input = document.getElementById("node-search");
        if (input) {
          event.preventDefault();
          input.focus();
        }
      }
      if (event.key === "Escape") {
        setMenuOpen(false);
        setNavOpen(false);
        setModal(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedNotes() && !hasVolatileAnswerDrafts()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, []);
  const run = useCallback(async <T,>(key: string, action: () => Promise<T>) => {
    setBusy(true);
    setBusyKey(key);
    setError("");
    try {
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
      return undefined;
    } finally {
      setBusy(false);
      setBusyKey("");
    }
  }, []);
  const refreshCourse = useCallback((value: Course) => {
    // A delayed save must never reopen a course the user has already left.
    setCourse((current) => current?.id === value.id && current.revision <= value.revision ? value : current);
    setCourses((list) =>
      list.map((c) =>
        c.id === value.id && c.revision <= value.revision
          ? {
              ...c,
              title: value.title,
              revision: value.revision,
              node_count: value.nodes.length,
              passed_count: value.nodes.filter((n) => n.status === "passed")
                .length,
              material_count: value.materials.length,
            }
          : c,
      ),
    );
  }, []);
  const eligibleNodes = useMemo(() => {
    if (!course) return [];
    const reviewIds = course.review_scope?.node_ids || [];
    return course.review_scope?.enabled
      ? course.nodes.filter((node) => reviewIds.includes(node.id))
      : course.nodes;
  }, [course]);
  const reviewEnabled = Boolean(course?.review_scope?.enabled);
  const activeNodes = useMemo(
    () =>
      eligibleNodes.filter(
        (n) =>
          (!directWeek || n.week === directWeek) &&
          (!directNodeId || n.id === directNodeId || n.unlocked || reviewEnabled),
      ) || [],
    [eligibleNodes, directWeek, directNodeId, reviewEnabled],
  );
  const reviewUiKey = course?.review_scope?.enabled
    ? `review:${[...course.review_scope.material_ids].sort().join(",")}:${course.review_scope.key}`
    : "course";
  const reviewStrict = Boolean(course?.review_scope?.enabled && course.review_scope.ai_scope === "selected");
  const displayCourse = useMemo(() => course ? ({
    ...course,
    nodes: activeNodes,
    route: course.route ? {
      ...course.route,
      stages: course.route.stages.map((stage) => ({ ...stage, node_ids: stage.node_ids.filter((id) => activeNodes.some((node) => node.id === id)) })).filter((stage) => stage.node_ids.length),
      next_node_id: (course.review_scope?.enabled
        ? activeNodes.filter((node) => node.status !== "passed" && node.status !== "mastered")
          .find((node) => node.id === course.route?.next_node_id)
          || activeNodes.find((node) => node.status !== "passed" && node.status !== "mastered")
        : recommendedNode(course, activeNodes))?.id || null,
      completed_count: activeNodes.filter((node) => node.status === "passed" || node.status === "mastered").length,
      total: activeNodes.length,
    } : undefined,
  }) : null, [course, activeNodes]);
  const selectedNode = selected && activeNodes.find((node) => node.id === selected.id)
    || (course ? recommendedNode(course, activeNodes) : undefined);
  const selectedNodeId = selectedNode?.id;
  const goalHintIds = useMemo(() => course && selectedNodeId && !mapGoal
    ? goalsForNode(course, selectedNodeId).find((entry) => entry.goal.status !== "done")?.path : undefined, [course, selectedNodeId, mapGoal]);
  const selectedRelation = activeRelationId ? course?.edges.find((edge) => edge.id === activeRelationId) : undefined;
  const activeRelation = selectedRelation && course && isRelationVisible(course, selectedRelation, reviewStrict)
    && activeNodes.some((node) => node.id === selectedRelation.source)
    && activeNodes.some((node) => node.id === selectedRelation.target) ? selectedRelation : undefined;
  const open = async (id: string) => {
    const value = await run("course", () => api.course(id));
    if (value) {
      setCourse(value);
      setSelected(recommendedNode(value));
      setActiveRelationId("");
      setRelationContextNodeId("");
      setRelationBackStack([]);
      setDirectWeek("");
      setDirectNodeId("");
      setDirectQuery("");
    }
  };
  const openMapNote = (node: LearningNode, noteId: string) => {
    setNoteTarget(node.id); setNoteTargetId(noteId); setNoteRequest((value) => value + 1);
    setDirectWeek(""); setDirectQuery(""); setActiveRelationId(""); setRelationBackStack([]);
    setSelected(node); setDirectNodeId(node.id); setModal(null); setSheetOpen(true);
  };
  const lineAct = async (key: string, fn: () => Promise<Course>) => {
    const value = await run(key, fn);
    if (value) refreshCourse(value);
    return value;
  };
  const openSettings = async () => {
    const value = await run("settings", api.settings);
    if (value) {
      setSettings(value);
      setModal("settings");
    }
  };
  const openProfile = async () => {
    const value = await run("profile", api.profile);
    if (value) {
      setProfile(value);
      setModal("profile");
    }
  };
  const openVersions = async () => {
    if (!course) return;
    const value = await run("versions", () => api.versions(course.id));
    if (value) {
      setVersions(value);
      setModal("versions");
    }
  };
  const openImport = async () => {
    const preferences =
      settings || (await run("import-settings", api.settings));
    if (!preferences || !course) return;
    setSettings(preferences);
    setParser(preferences.parser);
    setPickedFiles([]);
    setWeek("");
    setModal("import");
  };
  const saveSettings = async () => {
    if (!settings) return;
    const value = await run("save-settings", () =>
      api.saveSettings({
        ai_enabled: settings.ai_enabled,
        model: settings.model,
        note_review_model: settings.note_review_model || "gpt-6-luna",
        reasoning_effort: settings.reasoning_effort || "medium",
        obsidian_vault: settings.obsidian_vault,
        parser: settings.parser,
      }),
    );
    if (value) {
      setSettings(value);
      setAiEnabled(value.ai_enabled);
      setModal(null);
      try {
        setHealth(await api.health());
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "读取服务状态失败",
        );
      }
    }
  };
  const beginRestore = async (versionId: string) => {
    if (!course) return;
    const p = await run("restore-preview", () =>
      api.restorePreview(course.id, versionId),
    );
    if (p) {
      setPreview(p);
      setModal("restore");
    }
  };
  const beginDelete = async () => {
    if (!course) return;
    const p = await run("delete-preview", () => api.deletePreview(course.id));
    if (p) {
      setPreview(p);
      setModal("delete");
    }
  };
  const showRecall = async () => {
    if (!course || !selectedNode) return;
    const value = await run("recall", () => api.recall(course.id, selectedNode.id));
    if (value) {
      setRecall(value);
      setModal("recall");
    }
  };
  const showObsidian = async () => {
    const value = await run("settings", api.settings);
    if (value) {
      setSettings(value);
      setModal("obsidian");
      setNotes([]);
      setNotePath("");
      setNoteContent("");
      setPreview(undefined);
    }
  };
  const openReview = () => {
    if (!course) return;
    setReviewMaterialIds(course.review_scope?.enabled ? course.review_scope.material_ids : []);
    setReviewAiScope(course.review_scope?.ai_scope || "selected");
    setModal("review");
  };
  const navigateRelatedNode = (node: LearningNode, edge?: Course["edges"][number]) => {
    if (!course) return;
    const strict = Boolean(course.review_scope?.enabled && course.review_scope.ai_scope === "selected");
    if (strict && !course.review_scope.node_ids.includes(node.id)) return;
    setRelationBackStack((stack) => [...stack, { nodeId: selectedNode?.id || node.id, scopeKey: reviewUiKey }]);
    setRelationContextNodeId(selectedNode?.id || node.id);
    setActiveRelationId(edge?.id || activeRelationId);
    setDirectWeek("");
    setDirectQuery("");
    setDirectNodeId(node.id);
    setSelected(node);
    setSheetOpen(true);
  };
  const closeRelationDetail = () => {
    setActiveRelationId("");
    const target = course?.nodes.find((node) => node.id === relationContextNodeId);
    setRelationContextNodeId("");
    if (relationBackStack.at(-1)?.scopeKey === reviewUiKey) setRelationBackStack((stack) => stack.slice(0, -1));
    if (target) {
      setDirectNodeId(target.id);
      setSelected(target);
    }
  };
  const returnToRelationTarget = () => {
    const entry = relationBackStack.at(-1);
    if (!entry || entry.scopeKey !== reviewUiKey) return;
    const target = course?.nodes.find((node) => node.id === entry.nodeId);
    setRelationBackStack((stack) => stack.slice(0, -1));
    setActiveRelationId("");
    setRelationContextNodeId("");
    if (target) {
      setDirectNodeId(target.id);
      setSelected(target);
      setSheetOpen(true);
    }
  };
  const saveReviewScope = async (enabled: boolean) => {
    if (!course) return;
    const value = await run("review-scope", () => api.reviewScope(course.id, {
      enabled,
      material_ids: enabled ? reviewMaterialIds : [],
      ai_scope: reviewAiScope,
    }));
    if (value) {
      refreshCourse(value);
      setModal(null);
      setActiveRelationId("");
      setRelationContextNodeId("");
      setRelationBackStack([]);
      setDirectWeek(""); setDirectNodeId(""); setDirectQuery("");
      const ids = value.review_scope?.enabled ? value.review_scope.node_ids : value.nodes.map((node) => node.id);
      setSelected(recommendedNode(value, value.nodes.filter((node) => ids.includes(node.id))));
    }
  };
  const profileAfterAccept = async (id: string) => {
    const value = await run("accept-stage", () => api.acceptStage(id));
    if (value) setProfile(value);
  };
  const onRatingSubmitted = async () => {
    const value = await run("profile", api.profile);
    if (value && value.ratings_count > 0 && value.ratings_count % 10 === 0) {
      setProfile(value);
      setModal("profile");
    }
  };

  const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);
  const aiOn = Boolean(health?.ai.available && aiEnabled);
  const openCourseNotes = useCallback(async () => {
    if (!course) return;
    setModal("course-notes");
    const latest = await run("course-notes", () => api.course(course.id));
    if (latest) refreshCourse(latest);
  }, [course, run, refreshCourse]);
  const openGoalNode = (id: string, destination: "node" | "chat" = "node") => {
    const node = course?.nodes.find((item) => item.id === id);
    if (!node) return;
    setGoalChatTarget(destination === "chat" ? node.id : "");
    setNoteTarget(""); setDirectWeek(""); setDirectQuery("");
    setActiveRelationId(""); setRelationBackStack([]);
    setSelected(node); setDirectNodeId(node.id); setModal(null); setSheetOpen(true);
  };
  const sideTools = [
    { label: "目标看板", Icon: Target, onClick: () => { setGoalFocus(""); setModal("goals"); }, disabled: !course || busy },
    { label: "课程笔记", Icon: BookMarked, onClick: openCourseNotes, disabled: !course },
    { label: "学习档案", Icon: Archive, onClick: () => void openProfile() },
    { label: "Obsidian 导入导出", Icon: NotebookPen, onClick: () => void showObsidian() },
    { label: "设置", Icon: Settings2, onClick: () => void openSettings() },
  ];

  return (
    <TooltipProvider delayDuration={250}>
    <div className={cn("shell flex h-dvh overflow-hidden bg-background text-foreground", navOpen && "nav-open")}>
      {navOpen && <div className="fixed inset-0 z-40 bg-black/60 min-[781px]:hidden" onClick={() => setNavOpen(false)} aria-hidden />}
      <aside
        className={cn(
          "shell-side z-50 flex w-60 shrink-0 flex-col border-r border-border bg-sidebar px-3 py-4",
          "max-[780px]:fixed max-[780px]:inset-y-0 max-[780px]:left-0 max-[780px]:w-72 max-[780px]:shadow-2xl max-[780px]:transition-transform",
          !navOpen && "max-[780px]:-translate-x-full",
        )}
        aria-label="课程与工具"
      >
        <div className="flex items-center gap-2.5 px-2 pb-5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <GraduationCap size={17} aria-hidden />
          </span>
          <div className="rail-hide min-w-0 leading-tight">
            <div className="text-sm font-semibold">Learning Map</div>
            <div className="text-xs text-muted-foreground">知识地图</div>
          </div>
        </div>
        <div className="rail-hide flex items-center justify-between px-2 pb-1.5 text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5"><Library size={13} aria-hidden /> 我的课程</span>
          <span>{courses.length}</span>
        </div>
        <nav className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {courses.map((c) => {
            const done = course?.id === c.id && course.progress ? course.progress.nodes.done : c.passed_count;
            const total = course?.id === c.id && course.route ? course.route.total : c.node_count;
            const chosen = course?.id === c.id;
            return (
              <Tooltip key={c.id}>
                <TooltipTrigger asChild>
                  <button
                    className={cn(
                      "course-item group flex w-full cursor-pointer flex-col gap-1.5 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:cursor-wait",
                      chosen && "chosen bg-accent text-foreground",
                    )}
                    onClick={() => { setNavOpen(false); void open(c.id); }}
                    disabled={busy}
                    aria-current={chosen ? "page" : undefined}
                    aria-label={c.title}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <BookMarked size={15} className="shrink-0" aria-hidden />
                      <span className="rail-hide truncate font-medium">{c.title}</span>
                    </span>
                    <span className="rail-hide flex items-center gap-2">
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-secondary">
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${percent(done, total)}%` }} />
                      </span>
                      <small className="text-xs tabular-nums text-muted-foreground">{done}/{total}</small>
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="rail-tip">{c.title} · {done}/{total}</TooltipContent>
              </Tooltip>
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="rail-center mt-1 justify-start px-2.5"
            onClick={() => { setNavOpen(false); setTitle(""); setModal("create"); }}
            aria-label="新建课程"
          >
            <Plus /> <span className="rail-hide">新建课程</span>
          </Button>
        </nav>
        <div className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3">
          {sideTools.map(({ label, Icon, onClick, disabled }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="rail-center justify-start px-2.5" aria-label={label} disabled={disabled}
                  onClick={() => { setNavOpen(false); onClick(); }}>
                  <Icon /> <span className="rail-hide">{label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="rail-tip">{label}</TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rail-center mt-2 flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2">
                {aiOn ? <Bot size={16} className="shrink-0 text-st-passed" aria-hidden /> : <BotOff size={16} className="shrink-0 text-muted-foreground" aria-hidden />}
                <div className="rail-hide min-w-0 leading-tight">
                  <div className="truncate text-[13px] font-medium">
                    {health?.ai.available ? (aiEnabled ? "AI 学习辅助已启用" : "Codex 已找到 · 待启用") : "本地学习模式"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {health?.ai.available ? "登录状态未检测" : health ? "未找到 Codex，AI 功能不可用" : "正在检测 Codex…"}
                  </div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-72">
              {health?.ai.reason || (aiOn ? "AI 学习辅助已启用" : "本地学习模式")}
              {health?.data_dir && <div className="opacity-70">数据保存在本机：{shortPath(health.data_dir)}</div>}
            </TooltipContent>
          </Tooltip>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col max-[780px]:pb-14">
        {error && (
          <div className="mx-4 mt-3 flex items-center gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            <AlertCircle size={16} className="shrink-0" />
            <span className="flex-1">{error}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => setError("")} aria-label="关闭错误"><X /></Button>
          </div>
        )}
        {course ? (
          <>
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 max-[780px]:h-auto max-[780px]:flex-wrap max-[780px]:py-2.5">
              <Button variant="ghost" size="icon-sm" className="min-[781px]:hidden" onClick={() => setNavOpen(true)} aria-label="打开课程列表">
                <Menu />
              </Button>
              <div className="min-w-0 flex-1">
                <h1 className="t-page truncate">{course.title}</h1>
                <div className="mt-0.5 flex items-center gap-3 overflow-hidden whitespace-nowrap text-xs text-muted-foreground [&_svg]:size-3">
                  <span className="flex items-center gap-1"><History aria-hidden /> 版本 {course.revision}</span>
                  <span className="flex items-center gap-1"><FileText aria-hidden /> {course.materials.length} 份材料</span>
                  <span className="flex items-center gap-1 max-[1100px]:hidden"><Layers aria-hidden /> {course.nodes.length} 个知识点</span>
                  {course.route && <span className="flex items-center gap-1.5 text-foreground/80">
                    <span className="h-1 w-14 overflow-hidden rounded-full bg-secondary"><span className="block h-full bg-st-passed" style={{ width: `${(course.progress?.ratio ?? (course.route.total ? course.route.completed_count / course.route.total : 0)) * 100}%` }} /></span>
                    {course.progress?.pieces.total ? `${course.progress.pieces.known}/${course.progress.pieces.total} 知识块已掌握` : `${course.route.completed_count}/${course.route.total} 站已掌握`}
                  </span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {course.review_scope?.enabled ? (
                  <div className="flex items-center gap-1 rounded-lg border border-st-new/30 bg-st-new/10 py-1 pl-2.5 pr-1 text-xs text-st-new">
                    <FileSearch size={14} aria-hidden />
                    <span className="max-w-64 truncate">复习模式 · {course.review_scope.material_ids.length} 份 PDF · AI {course.review_scope.ai_scope === "selected" ? "仅参考所选" : "参考整门课"}</span>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-st-new hover:text-st-new" onClick={openReview}><Pencil /> 编辑</Button>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-st-new hover:text-st-new" onClick={() => void saveReviewScope(false)} disabled={busy}><LogOut /> 退出</Button>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" className="max-[780px]:hidden" onClick={openReview} disabled={busy}>
                    <FileSearch /> 复习所选 PDF
                  </Button>
                )}
                <Button size="sm" onClick={() => void openImport()} disabled={busy}>
                  <Upload /> <span className="max-[480px]:hidden">导入材料</span>
                </Button>
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" aria-label="更多课程操作"><Ellipsis /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {course.materials.length > 0 && (
                      <DropdownMenuItem
                        disabled={busy || !aiEnabled || !health?.ai.available}
                        onSelect={() => void run("generate", () => api.generate(course.id)).then((v) => v && refreshCourse(v))}
                      >
                        <Sparkles /> {course.nodes.length ? "更新地图" : "生成知识地图"}
                        {(!aiEnabled || !health?.ai.available) && <DropdownMenuShortcut>需启用 AI</DropdownMenuShortcut>}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setModal("materials")}>
                      <FolderOpen /> 已导入材料 <DropdownMenuShortcut>{course.materials.length} 份</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={busy} onSelect={() => void run("snapshot", () => api.snapshot(course.id)).then((v) => v && refreshCourse(v))}>
                      <Save /> 保存版本
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void openVersions()}>
                      <History /> 版本历史
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => void beginDelete()}>
                      <Trash2 /> 删除课程…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>
            {course.materials.length > 0 && !course.nodes.length && (
              <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl border border-border bg-card p-4">
                <span className="grid size-9 place-items-center rounded-lg bg-secondary"><Sparkles size={17} aria-hidden /></span>
                <div className="flex-1">
                  <div className="text-sm font-semibold">材料已就绪</div>
                  <div className="text-[13px] text-muted-foreground">
                    {aiEnabled ? "分析课程材料并生成知识地图。" : "请先在设置中启用 AI，并确认数据发送说明。"}
                  </div>
                </div>
                <Button
                  onClick={() => void run("generate", () => api.generate(course.id)).then((v) => v && refreshCourse(v))}
                  disabled={busy || !aiEnabled || !health?.ai.available}
                >
                  <Sparkles /> 生成知识地图
                </Button>
              </div>
            )}
            {!explainHidden && course.edges.some(needsBridges) && (
              <div className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
                <Waypoints size={17} className="shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 text-sm">
                  <strong className="font-semibold">{course.edges.filter(needsBridges).length} 条联系还没有知识桥</strong>
                  <span className="block text-xs text-muted-foreground max-[780px]:hidden">让 AI 根据材料写清“后一个知识点的哪一步用到了前一个的哪一块”，并配一道检验题。每次处理 12 条，结果标为待核对，不改变进度和解锁。</span>
                </div>
                {aiOn ? <Button size="sm" disabled={busy}
                  onClick={() => void run("backfill-relations", () => api.backfillRelations(course.id, course.revision)).then((v) => v && refreshCourse(v))}>
                  <Sparkles /> 用 AI 补充知识桥
                </Button> : <Button size="sm" variant="outline" onClick={() => void openSettings()}>先在设置中开启 AI</Button>}
                <Button size="icon-sm" variant="ghost" aria-label="暂时隐藏" onClick={() => setExplainHidden(true)}><X /></Button>
              </div>
            )}
            <div className="study-workspace flex min-h-0 flex-1">
              <section className="graph-area relative flex min-w-0 flex-1 flex-col">
                {course.review_scope?.enabled && activeNodes.length === 0 && (
                  <div className="mx-4 mt-3 flex gap-3 rounded-lg border border-border bg-card p-3 text-[13px]">
                    <FileSearch size={18} className="shrink-0 text-muted-foreground" />
                    <div><strong className="block font-medium">所选 PDF 暂无匹配知识点</strong><span className="text-muted-foreground">这份材料当前没有关联到已生成的节点。可以更换复习资料，或退出复习；无需重新导入文件。</span></div>
                  </div>
                )}
                <CourseMap
                  key={`${course.id}-${reviewUiKey}`}
                  course={displayCourse || course}
                  prerequisiteNodes={course.nodes}
                  selected={selectedNode}
                  reviewActive={Boolean(course.review_scope?.enabled)}
                  reviewStrict={reviewStrict}
                  directEntryId={directNodeId}
                  directWeek={directWeek}
                  focusIds={course.goals?.find((goal) => goal.id === mapGoal)?.route_ids}
                  hintIds={goalHintIds}
                  onOpenLine={(id) => { setLineFocus(id); setModal("lines"); }}
                  toolbar={
                    <div className="flex min-w-0 items-center gap-2 max-[780px]:w-full">
                      <Button size="sm" variant="outline" onClick={() => { setLineFocus(""); setModal("lines"); }}>课程全貌</Button>
                      {selectedNode && <Button size="sm" variant="ghost" disabled={busy || reviewStrict} onClick={() => void lineAct("goal-endpoint", () => api.addGoal(course.id, {
                        title: `学会 ${selectedNode.title}`, description: "以图上的这个知识点为终点", kind: "personal", status: "doing", node_ids: [selectedNode.id], subtasks: [],
                      })).then((updated) => { const goal = updated?.goals?.at(-1); if (goal) setMapGoal(goal.id); })} aria-label="设为目标终点" title="把选中的知识点设为一个目标的终点"><Target /><span className="max-[1199px]:hidden">设为目标终点</span></Button>}

                      {!!course.goals?.length && <label className="relative flex items-center max-[780px]:hidden">
                        <Target size={14} className="pointer-events-none absolute left-2.5 text-muted-foreground" aria-hidden />
                        <select className="h-8 max-w-48 cursor-pointer appearance-none !py-0 !pl-8 !pr-7" aria-label="按目标聚焦"
                          value={mapGoal} onChange={(event) => setMapGoal(event.target.value)}>
                          <option value="">全部目标</option>
                          {course.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
                        </select>
                        <ChevronDown size={14} className="pointer-events-none absolute right-2 text-muted-foreground" aria-hidden />
                      </label>}
                      {course.nodes.some((n) => n.week) && <label className="relative flex items-center max-[780px]:hidden">
                        <CalendarDays size={14} className="pointer-events-none absolute left-2.5 text-muted-foreground" aria-hidden />
                        <select
                          className="h-8 cursor-pointer appearance-none !py-0 !pl-8 !pr-7"
                          aria-label="按周次直达"
                          value={directWeek}
                          onChange={(e) => {
                            setDirectNodeId("");
                            setDirectWeek(e.target.value);
                            setSelected(undefined);
                          }}
                        >
                          <option value="">全部周次</option>
                          {Array.from(new Set(eligibleNodes.map((n) => n.week).filter(Boolean))).map((w) => (
                            <option key={w} value={w}>{w}</option>
                          ))}
                        </select>
                        <ChevronDown size={14} className="pointer-events-none absolute right-2 text-muted-foreground" aria-hidden />
                      </label>}
                      <label className="flex h-8 w-56 min-w-0 items-center gap-2 rounded-md border border-input bg-field px-2.5 text-muted-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,.45)] hover:border-zinc-600 focus-within:border-zinc-500 focus-within:ring-[3px] focus-within:ring-ring/20 max-[1100px]:w-44 max-[780px]:flex-1">
                        <Search size={14} className="shrink-0" aria-hidden />
                        <input
                          id="node-search"
                          className="!m-0 min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-[13px] text-foreground !shadow-none outline-none placeholder:text-muted-foreground"
                          list="map-targets"
                          aria-label="搜索并直达知识点"
                          placeholder="搜索或直达知识点"
                          value={directQuery}
                          onChange={(e) => {
                            const query = e.target.value;
                            setDirectQuery(query);
                            const match = eligibleNodes.find((n) => n.title === query);
                            if (match) {
                              setDirectNodeId(match.id);
                              setDirectWeek("");
                              setSelected(match);
                            }
                          }}
                        />
                        <kbd className="rounded border border-border px-1.5 font-sans text-xs leading-4 text-muted-foreground max-[780px]:hidden">Ctrl K</kbd>
                      </label>
                      <datalist id="map-targets">
                        {eligibleNodes.map((n) => <option key={n.id} value={n.title} />)}
                      </datalist>
                      {(directQuery || directNodeId || directWeek) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label="清除临时直达"
                              onClick={() => {
                                setDirectWeek("");
                                setDirectNodeId("");
                                setDirectQuery("");
                                setSelected(recommendedNode(course, eligibleNodes));
                              }}>
                              <RotateCcw />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>清除临时直达</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  }
                  onSelect={(node) => {
                    if (directWeek && node.week !== directWeek) setDirectWeek("");
                    setActiveRelationId("");
                    setRelationBackStack([]);
                    setSelected(node);
                    setSheetOpen(true);
                  }}
                  onRelationSelect={(edge) => {
                    setRelationContextNodeId(selectedNode?.id || edge.target);
                    setActiveRelationId(edge.id);
                    const target = course.nodes.find((node) => node.id === edge.target);
                    if (target) { setSelected(target); setSheetOpen(true); }
                  }}
                />
                <div className="study-content-host" ref={setContentContainer} />
              </section>
              <div
                className={cn(
                  "node-dock flex w-[380px] shrink-0 flex-col overflow-hidden border-l border-border bg-sidebar max-[1180px]:w-[340px]",
                  "max-[781px]:fixed max-[781px]:inset-x-0 max-[781px]:bottom-14 max-[781px]:z-30 max-[781px]:h-[62dvh] max-[781px]:w-auto max-[781px]:rounded-t-2xl max-[781px]:border-l-0 max-[781px]:border-t max-[781px]:shadow-2xl max-[781px]:transition-transform",
                  !sheetOpen && "max-[781px]:translate-y-[calc(100%-44px)]",
                  sheetOpen && "open",
                )}
              >
                <button className="mx-auto flex h-11 w-full shrink-0 cursor-pointer items-center justify-center text-muted-foreground min-[781px]:hidden"
                  onClick={() => setSheetOpen((v) => !v)} aria-label={sheetOpen ? "收起节点详情" : "展开节点详情"}>
                  <span className="h-1 w-10 rounded-full bg-zinc-700" />
                </button>
                {selectedNode ? (
                  <GoalActionsContext.Provider value={{
                    focusedGoal: mapGoal,
                    onFocusGoal: (goalId) => setMapGoal((current) => current === goalId ? "" : goalId),
                    onOpenNode: openGoalNode,
                    changes: goalChanges?.courseId === course.id ? goalChanges.changes : [],
                    onDismissChanges: () => setGoalChanges(undefined),
                  }}>
                  <NodePanel
                    key={`${course.id}-${selectedNode.id}-${reviewUiKey}-${noteTarget === selectedNode.id ? noteRequest : 0}-${goalChatTarget === selectedNode.id}`}
                    course={course}
                    node={selectedNode}
                    initialNote={noteTarget === selectedNode.id}
                    initialNoteId={noteTarget === selectedNode.id ? noteTargetId : ""}
                    initialChat={goalChatTarget === selectedNode.id}
                    contentContainer={contentContainer}
                    reviewActive={Boolean(course.review_scope?.enabled)}
                    reviewStrict={reviewStrict}
                    relation={activeRelation}
                    relationReturnAvailable={Boolean(relationBackStack.at(-1)?.scopeKey === reviewUiKey)}
                    onNavigateNode={navigateRelatedNode}
                    onReturnToTarget={returnToRelationTarget}
                    onOpenReview={openReview}
                    onExitReview={() => void saveReviewScope(false)}
                    onOpenNote={openMapNote}
                    onCloseRelation={closeRelationDetail}
                    onOpenRelation={(edge) => { setRelationContextNodeId(selectedNode.id); setActiveRelationId(edge.id); }}
                    onOpenGoal={(goalId) => { setGoalFocus(goalId); setModal("goals"); }}
                    directEntryId={directNodeId}
                    directWeek={directWeek}
                    busy={busy}
                    aiEnabled={aiEnabled}
                    aiAvailable={Boolean(health?.ai.available)}
                    noteReviewModel={settings?.note_review_model || "gpt-6-luna"}
                    run={run}
                    onRefresh={refreshCourse}
                    onRecall={() => void showRecall()}
                    onRatingSubmitted={() => void onRatingSubmitted()}
                  />
                  </GoalActionsContext.Provider>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
                    <span className="grid size-11 place-items-center rounded-xl border border-border bg-card"><MousePointerClick size={18} /></span>
                    选择一个知识点查看详情
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="relative flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <Button variant="ghost" size="icon-sm" className="absolute left-3 top-3 min-[781px]:hidden" onClick={() => setNavOpen(true)} aria-label="打开课程列表">
              <Menu />
            </Button>
            <span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground"><GraduationCap size={24} aria-hidden /></span>
            <Badge variant="outline">本地学习空间</Badge>
            <h1 className="text-3xl font-semibold leading-snug tracking-tight">把知识连起来，<br />把思路留住。</h1>
            <p className="max-w-md text-muted-foreground">从理解课程材料开始，逐步建立自己的知识地图与判断能力。</p>
            <div className="flex flex-wrap justify-center gap-2.5">
              <Button size="lg" onClick={() => { setTitle(""); setModal("create"); }}><Plus /> 创建课程</Button>
              <Button size="lg" variant="outline" onClick={() => void run("sample", api.sample).then((v) => v && loadCourses(v.id))}>
                <FilePlus2 /> 试用示例课程
              </Button>
            </div>
            <small className="text-xs text-muted-foreground">示例课程明确标注为示例，且从零进度开始</small>
            <small className="flex items-center gap-1.5 text-xs text-muted-foreground" title={health?.data_dir}>
              <ShieldCheck size={13} /> 数据保存在本机 · {health?.data_dir ? shortPath(health.data_dir) : "等待本地服务"}
            </small>
          </div>
        )}
        <nav className="fixed inset-x-0 bottom-0 z-40 grid h-14 grid-cols-5 border-t border-border bg-sidebar min-[781px]:hidden" aria-label="主要功能">
          {[
            { label: "地图", Icon: MapIcon, on: !modal, onClick: () => { setModal(null); setSheetOpen(false); } },
            { label: "目标", Icon: Target, on: modal === "goals", onClick: () => { setGoalFocus(""); setModal("goals"); }, disabled: !course || busy },
            { label: "笔记", Icon: NotebookPen, on: modal === "course-notes", onClick: () => void openCourseNotes(), disabled: !course },
            { label: "复习", Icon: FileSearch, on: modal === "review", onClick: openReview, disabled: !course || busy },
            { label: "更多", Icon: Menu, on: false, onClick: () => setNavOpen(true) },
          ].map(({ label, Icon, on, onClick, disabled }) => (
            <button key={label} className={cn("flex cursor-pointer flex-col items-center justify-center gap-0.5 text-xs text-muted-foreground disabled:opacity-40", on && "text-foreground")}
              onClick={onClick} disabled={disabled}>
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
      </main>
      {modal && (
        <div
          className="modal-scrim"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className={`modal ${["profile", "versions", "obsidian", "recall", "import", "materials", "goals", "course-notes"].includes(modal) ? "modal-wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="modal-head">
              <span className="modal-icon" aria-hidden>{modalIcon(modal)}</span>
              <h2 id="modal-title">{modalTitle(modal)}</h2>
              <button
                className="icon-btn"
                onClick={() => setModal(null)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            {modal === "lines" && course && <LinesPanel key={`${course.id}:${lineFocus}`} course={course} initialLineId={lineFocus} busy={busy} aiEnabled={aiOn} act={lineAct}
              onNode={(node) => { setSelected(node); setDirectNodeId(node.id); setActiveRelationId(""); setModal(null); setSheetOpen(true); }} onNote={openMapNote} />}
            {modal === "goals" && course && <GoalBoard key={`${course.id}:${goalFocus}`} initialGoalId={goalFocus} course={course} busy={busy} aiEnabled={aiOn} run={run} onRefresh={refreshCourse} onNode={openGoalNode} />}
            {modal === "course-notes" && course && <CourseNotes course={course}
              onExitReview={() => void saveReviewScope(false).then(() => setModal("course-notes"))}
              onOpen={(node, noteId = "") => {
                setNoteTarget(node.id); setNoteTargetId(noteId); setNoteRequest((value) => value + 1);
                setDirectWeek(""); setDirectQuery(""); setActiveRelationId(""); setRelationBackStack([]);
                setSelected(node); setDirectNodeId(node.id); setModal(null); setSheetOpen(true);
              }} />}
            {modal === "materials" && course && (
              <div className="modal-body">
                {course.materials.length ? (
  <div className="materials-list">
                    {course.materials.map((material) => (
                      <details className="material-card" key={material.id}>
                        <summary>
                          <FilePlus2 size={14} />
                          <span>{material.name}</span>
                          <small>
                            {material.week || "未分周"} · {material.pages.length}{" "}
                            页
                          </small>
                        </summary>
                        {material.warnings.length > 0 && (
                          <ul className="warning-list">
                            {material.warnings.map((warning, index) => (
                              <li key={`${material.id}-warning-${index}`}>
                                {warning}
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="material-pages">
                          {material.pages.map((page) => (
                            <details key={`${material.id}-${page.number}`}>
                              <summary>
                                第 {page.number} 页 · {page.method}
                                {page.uncertain ? " · 识别不确定" : ""}
                              </summary>
                              <p>
                                {page.text ||
                                  "此页未提取到文字；请核对原始页面图像。"}
                              </p>
                              {page.warnings.map((warning, index) => (
                                <span
                                  className="page-warning"
                                  key={`${page.number}-warning-${index}`}
                                >
                                  {warning}
                                </span>
                              ))}
                              <a
                                href={materialFileUrl(course.id, material.id, page.number)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                打开原始文件第 {page.number} 页
                              </a>
                              <img
                                loading="lazy"
                                src={`/api/courses/${course.id}/materials/${material.id}/pages/${page.number}`}
                                alt={`${material.name} 第 ${page.number} 页原始页面`}
                              />
                            </details>
                          ))}
                        </div>
                      </details>
                    ))}
                  </div>
                ) : (
                  <p className="muted">还没有导入材料。</p>
                )}
              </div>
            )}
            {modal === "create" && (
              <div className="modal-body">
                <p className="muted">
                  创建一门独立课程，材料、地图、对话和学习记录会分别保存。
                </p>
                <label className="field-label">
                  课程名称
                  <input
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：COMP2041 · 软件构造"
                  />
                </label>
                <button
                  className="primary full"
                  disabled={!title.trim() || busy}
                  onClick={() =>
                    void run("create", () => api.create(title.trim())).then(
                      (v) => {
                        if (v) {
                          setModal(null);
                          void loadCourses(v.id);
                        }
                      },
                    )
                  }
                >
                  <Plus size={16} />
                  创建课程
                </button>
              </div>
            )}
            {modal === "import" && course && (
              <div className="modal-body">
                <p className="muted">
                  原始 PDF
                  会保持不变。导入内容复制到本地课程目录，并记录页码与提取不确定性。
                </p>
                <label className="dropzone">
                  <Upload size={23} />
                  <strong>
                    {pickedFiles.length
                      ? `已选择 ${pickedFiles.length} 个文件`
                      : "选择 PDF 或拖入文件"}
                  </strong>
                  <span>可以一次选择多份材料</span>
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    multiple
                    onChange={(e) =>
                      setPickedFiles(Array.from(e.target.files || []))
                    }
                  />
                </label>
                {pickedFiles.length > 0 && (
                  <div className="file-chips">
                    {pickedFiles.map((f) => (
                      <span key={`${f.name}-${f.size}`}>{f.name}</span>
                    ))}
                  </div>
                )}
                <div className="form-row">
                  <label className="field-label">
                    课程周次
                    <input
                      value={week}
                      onChange={(e) => setWeek(e.target.value)}
                      placeholder="例如：Week 03"
                    />
                  </label>
                  <label className="field-label">
                    文档解析
                    <select
                      value={parser}
                      onChange={(e) => setParser(e.target.value)}
                    >
                      <option value="basic">基础解析</option>
                      <option value="docling">Docling（如已安装）</option>
                    </select>
                  </label>
                </div>
                <button
                  className="primary full"
                  disabled={!pickedFiles.length || busy}
                  onClick={() =>
                    void run("import", () =>
                      api.importFiles(course.id, pickedFiles, week, parser),
                    ).then((v) => {
                      if (v) {
                        refreshCourse(v);
                        setModal(null);
                      }
                    })
                  }
                >
                  <Upload size={15} />
                  {pickedFiles.length ? `导入 ${pickedFiles.length} 份材料` : "导入材料"}
                </button>
              </div>
            )}
            {modal === "review" && course && (
              <div className="modal-body">
                <p className="muted">选择已导入的 PDF。复习范围只影响当前地图与 AI 材料引用，不会重置课程进度或历史记录。</p>
                {!course.materials.some((material) => material.kind === "pdf") ? (
                  <div className="empty-note"><FileSearch /><p>还没有已导入的 PDF</p><span>先导入课程 PDF，再按所选资料筛选相关知识点。</span></div>
                ) : <>
                  <div className="review-select-actions">
                    <strong>选择复习材料</strong>
                    <button className="quiet-button" onClick={() => setReviewMaterialIds(course.materials.filter((m) => m.kind === "pdf").map((m) => m.id))}>全选</button>
                    <button className="quiet-button" onClick={() => setReviewMaterialIds([])}>清空</button>
                  </div>
                  <div className="review-material-list">
                    {course.materials.filter((material) => material.kind === "pdf").map((material) => (
                      <label key={material.id} className="review-material-option">
                        <input type="checkbox" checked={reviewMaterialIds.includes(material.id)} onChange={(event) => setReviewMaterialIds((ids) => event.target.checked ? [...ids, material.id] : ids.filter((id) => id !== material.id))} />
                        <span><strong>{material.name}</strong><small>{material.week || "未分周"} · {material.pages.length} 页</small></span>
                      </label>
                    ))}
                  </div>
                  <label className="review-ai-option"><input type="checkbox" checked={reviewAiScope === "selected"} onChange={(event) => setReviewAiScope(event.target.checked ? "selected" : "course")} /> AI 仅参考所选资料</label>
                  <p className="muted small">取消勾选后，AI 可参考整门课程；地图仍只显示与所选 PDF 匹配的节点。</p>
                  {course.review_scope?.enabled && <button className="quiet-button" onClick={() => void saveReviewScope(false)} disabled={busy}>退出复习模式</button>}
                  <button className="primary full" onClick={() => void saveReviewScope(true)} disabled={busy || reviewMaterialIds.length === 0}>开始复习 ({reviewMaterialIds.length})</button>
                </>}
              </div>
            )}
            {modal === "settings" && settings && (
              <div className="modal-body">
                <div className="privacy-callout">
                  <ShieldCheck size={18} />
                  <p>
                    AI 默认关闭。开启后，课程材料节选、对话和作答会发送到 Codex
                    提供方处理。Codex
                    也可能在其用户目录保存会话记录；删除课程不会清除这些记录，它们由
                    Codex 与提供方的设置管理。
                  </p>
                </div>
                <label className="toggle-row">
                  <span>
                    <strong>启用 AI 学习辅助</strong>
                    <small>用于生成地图、节点对话和作答验收</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.ai_enabled}
                    onChange={(e) =>
                      setSettings({ ...settings, ai_enabled: e.target.checked })
                    }
                  />
                </label>
                <label className="field-label">
                  学习对话模型 / 提供方
                  <input
                    value={settings.model}
                    onChange={(e) =>
                      setSettings({ ...settings, model: e.target.value })
                    }
                    placeholder="使用本地服务配置"
                  />
                </label>
                <label className="field-label">
                  推理力度
                  <select
                    value={settings.reasoning_effort || "medium"}
                    onChange={(e) =>
                      setSettings({ ...settings, reasoning_effort: e.target.value as Settings["reasoning_effort"] })
                    }
                  >
                    <option value="low">低</option>
                    <option value="medium">中等</option>
                    <option value="high">高</option>
                  </select>
                </label>
                <label className="field-label">
                  笔记自动检查模型（独立）
                  <input value={settings.note_review_model || "gpt-6-luna"}
                    onChange={(event) => setSettings({ ...settings, note_review_model: event.target.value })}
                    placeholder="gpt-6-luna" />
                  <span className="text-xs text-muted-foreground">笔记检查默认 Luna／中等推理；不改变学习对话模型。</span>
                </label>
                <label className="field-label">
                  Obsidian 笔记库路径
                  <input
                    value={settings.obsidian_vault}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        obsidian_vault: e.target.value,
                      })
                    }
                    placeholder="选择或输入本地 vault 路径"
                  />
                </label>
                <label className="field-label">
                  PDF 解析方式
                  <select
                    value={settings.parser}
                    onChange={(e) =>
                      setSettings({ ...settings, parser: e.target.value })
                    }
                  >
                    <option value="basic">基础解析</option>
                    <option value="docling">Docling</option>
                  </select>
                </label>
                <p className="muted small">
                  设置仅保存本地配置；不会在此展示密钥。
                </p>
                <button
                  className="primary full"
                  onClick={() => void saveSettings()}
                  disabled={busy}
                >
                  保存设置
                </button>
              </div>
            )}
            {modal === "profile" && profile && (
              <div className="modal-body">
                <div className="profile-summary">
                  <div>
                    <strong>{profile.ratings_count}</strong>
                    <span>次评分提交</span>
                  </div>
                  <p>
                    每十次实际提交形成一阶段总结；跳过不计数。问题解决程度与知识掌握程度分别计算。
                  </p>
                </div>
                {profile.stages.length ? (
                  profile.stages.map((stage) => (
                    <article className="stage-card" key={stage.id}>
                      <div className="stage-heading">
                        <strong>阶段总结 · {stage.count} 次评分</strong>
                        <span className="tag">规则建议</span>
                        {stage.accepted ? (
                          <span className="tag success">已采用</span>
                        ) : (
                          <span className="tag">待决定</span>
                        )}
                      </div>
                      <div className="averages">
                        <span>
                          问题解决 <b>{stage.problem_average ?? "—"}</b> / 4
                        </span>
                        <span>
                          知识掌握 <b>{stage.mastery_average ?? "—"}</b> / 4
                        </span>
                      </div>
                      <p>{stage.advice}</p>
                      <p className="muted small">
                        {stage.basis ||
                          "根据这一阶段的实际评分生成规则建议；不代表 AI 对学习规律的判断。"}
                      </p>
                      {stage.ratings
                        ?.filter((rating) => rating.comment.trim())
                        .slice(-3)
                        .map((rating, index) => (
                          <div
                            className="feedback-record"
                            key={`${rating.created_at}-${index}`}
                          >
                            <span>
                              {rating.course_title || "课程"} · 问题解决{" "}
                              {rating.problem ?? "—"} / 4 · 知识掌握{" "}
                              {rating.mastery ?? "—"} / 4
                            </span>
                            <p>{rating.comment}</p>
                          </div>
                        ))}
                      {!stage.accepted && (
                        <button
                          className="secondary"
                          onClick={() => void profileAfterAccept(stage.id)}
                          disabled={busy}
                        >
                          <Check size={15} />
                          同意采用建议
                        </button>
                      )}
                    </article>
                  ))
                ) : (
                  <div className="empty-note">
                    <Clock3 />
                    <p>还没有完成十次评分。</p>
                    <span>
                      评分来自各知识节点的验收后反馈，达到十次后会在这里总结。
                    </span>
                  </div>
                )}
                {profile.suggestions.map((suggestion) => (
                  <article className="stage-card" key={suggestion.id}>
                    <div className="stage-heading">
                      <strong>学习难度建议</strong>
                      <span
                        className={`tag ${suggestion.accepted ? "success" : ""}`}
                      >
                        {suggestion.accepted ? "已采用" : "待确认"}
                      </span>
                    </div>
                    <p>
                      {String(suggestion.advice || JSON.stringify(suggestion))}
                    </p>
                    {!suggestion.accepted && (
                      <button
                        className="secondary"
                        onClick={() => {
                          const courseId = String(suggestion.course_id || "");
                          void run("suggestion", () =>
                            api.acceptSuggestion(courseId, suggestion.id),
                          ).then((updated) => {
                            if (updated) {
                              refreshCourse(updated);
                              void api.profile().then(setProfile);
                            }
                          });
                        }}
                        disabled={busy || !suggestion.course_id}
                      >
                        <Check size={15} />
                        同意采用建议
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
            {modal === "versions" && (
              <div className="modal-body">
                <p className="muted">
                  恢复前系统会自动保存当前整门课程。地图、节点对话、练习和评分会一起恢复。
                </p>
                <div className="version-actions">
                  <button
                    className="secondary"
                    onClick={() =>
                      course &&
                      void run("snapshot", () => api.snapshot(course.id)).then(
                        (v) =>
                          v &&
                          Promise.all([
                            loadCourses(course.id),
                            api.versions(course.id).then(setVersions),
                          ]),
                      )
                    }
                    disabled={busy}
                  >
                    <Archive size={15} />
                    保存当前版本
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void beginDelete()}
                    disabled={busy}
                  >
                    <Trash2 size={15} />
                    删除课程…
                  </button>
                </div>
                {versions.length ? (
                  <div className="version-list">
                    {versions.map((v) => (
                      <article className="version-item" key={v.id}>
                        <div>
                          <strong>{v.reason || "课程快照"}</strong>
                          <span>
                            {new Date(v.created_at).toLocaleString("zh-CN")} ·{" "}
                            {v.node_count} 个节点 · v{v.revision}
                          </span>
                        </div>
                        <button
                          className="secondary"
                          onClick={() => void beginRestore(v.id)}
                          disabled={busy}
                        >
                          <RotateCcw size={14} />
                          预览恢复
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-note">
                    <Archive />
                    <p>还没有已保存的版本</p>
                    <span>
                      课程操作会按服务端规则保存版本，也可手动创建快照。
                    </span>
                  </div>
                )}
              </div>
            )}
            {modal === "restore" && preview && course && (
              <ConfirmPreview
                preview={preview}
                busy={busy}
                onCancel={() => setModal("versions")}
                onConfirm={() =>
                  void run("restore", () =>
                    api.restore(course.id, preview.token),
                  ).then((v) => {
                    if (v) {
                      refreshCourse(v);
                      setModal(null);
                      void loadCourses(v.id);
                    }
                  })
                }
                confirm="确认恢复这个版本"
                icon={<RotateCcw size={16} />}
              />
            )}
            {modal === "delete" && preview && course && (
              <ConfirmPreview
                preview={preview}
                busy={busy}
                onCancel={() => setModal("versions")}
                onConfirm={() =>
                  void run("delete", () =>
                    api.delete(course.id, preview.token),
                  ).then((v) => {
                    if (v?.deleted) {
                      setCourse(null);
                      setSelected(undefined);
                      setModal(null);
                      void loadCourses();
                    }
                  })
                }
                confirm="确认删除课程"
                icon={<Trash2 size={16} />}
                danger
              />
            )}
            {modal === "obsidian" && (
              <div className="modal-body">
                <p className="muted">
                  只在设置的本地笔记库中搜索
                  Markdown。写入前会展示准确目标和内容，并且不会覆盖已有笔记。
                </p>
                <form
                  className="search-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run("notes", () => api.notes(noteQuery)).then(
                      (v) => v && setNotes(v),
                    );
                  }}
                >
                  <input
                    value={noteQuery}
                    onChange={(e) => setNoteQuery(e.target.value)}
                    placeholder="搜索笔记内容或路径"
                  />
                  <button className="secondary">
                    <FolderOpen size={15} />
                    搜索笔记
                  </button>
                </form>
                {notes.map((n) => (
                  <article className="note-result" key={n.path}>
                    <button
                      className="note-pick"
                      onClick={() => {
                        setNotePath(n.path);
                        setNoteContent(n.content);
                        setPreview(undefined);
                      }}
                    >
                      <strong>{n.path}</strong>
                      <span>{n.content.slice(0, 240)}</span>
                    </button>
                  </article>
                ))}
                <div className="obsidian-write">
                  <label className="field-label">
                    写入目标路径
                    <input
                      value={notePath}
                      onChange={(e) => {
                        setNotePath(e.target.value);
                        setPreview(undefined);
                      }}
                      placeholder="课程/主题笔记.md"
                    />
                  </label>
                  <label className="field-label">
                    笔记内容
                    <textarea
                      value={noteContent}
                      onChange={(e) => {
                        setNoteContent(e.target.value);
                        setPreview(undefined);
                      }}
                      rows={7}
                      placeholder="输入要保存到 Obsidian 的内容"
                    />
                  </label>
                  <button
                    className="secondary"
                    onClick={() =>
                      void run("note-preview", () =>
                        api.notePreview(notePath, noteContent),
                      ).then((v) => {
                        if (v) setPreview(v);
                      })
                    }
                    disabled={busy || !notePath || !noteContent}
                  >
                    预览写入内容
                  </button>
                  {preview && (
                    <div className="preview-card">
                      <strong>{preview.target}</strong>
                      <pre>{preview.content}</pre>
                      <p>{preview.warning}</p>
                      <div className="decision-row">
                        <button onClick={() => setPreview(undefined)}>
                          取消
                        </button>
                        <button
                          className="primary"
                          onClick={() =>
                            void run("note-write", () =>
                              api.noteWrite(preview.token),
                            ).then((v) => {
                              if (v) {
                                setNotePath(v.path);
                                setPreview(undefined);
                                setError(`已写入 ${v.path}`);
                              }
                            })
                          }
                          disabled={busy}
                        >
                          确认写入
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {modal === "recall" && recall && course && selectedNode && (
              <RecallPanel
                key={`${course.id}-${selectedNode.id}-${reviewUiKey}`}
                messages={recall.messages}
                note={recall.note}
                reviewLabel={course.review_scope?.enabled
                  ? course.review_scope.ai_scope === "selected"
                    ? "AI 整理当前所选 PDF 复习范围；下方原始对话仍显示全部历史。"
                    : "AI 整理整门课程范围，可能跨越多份材料；下方原始对话显示全部历史。"
                  : undefined}
                activeMessageCount={course.review_scope?.enabled && course.review_scope.ai_scope === "selected"
                  ? selectedNode.chats.length
                  : recall.messages.length}
                aiEnabled={aiEnabled}
                busy={busy}
                onSummarize={async (): Promise<RecallSummary | undefined> =>
                  run("recall-summary", () =>
                    api.recallSummary(course.id, selectedNode.id),
                  )
                }
              />
            )}
          </section>
        </div>
      )}
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={16} />
          {busyLabel(busyKey)}
        </div>
      )}
    </div>
    </TooltipProvider>
  );
}
function ConfirmPreview({
  preview,
  busy,
  onCancel,
  onConfirm,
  confirm,
  icon,
  danger = false,
}: {
  preview: Preview;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirm: string;
  icon: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="modal-body">
      <div className={`warning-callout ${danger ? "danger" : ""}`}>
        <AlertCircle size={19} />
        <p>{preview.warning}</p>
      </div>
      <div className="preview-card">
        <strong>{preview.target}</strong>
        {preview.contents?.map((item, i) => (
          <div className="preview-line" key={`${i}-${item}`}>
            {item}
          </div>
        ))}
      </div>
      <div className="decision-row">
        <button onClick={onCancel}>返回</button>
        <button
          className={danger ? "danger-button" : "primary"}
          disabled={busy}
          onClick={onConfirm}
        >
          {icon}
          {confirm}
        </button>
      </div>
    </div>
  );
}
function modalIcon(m: Modal) {
  const icons: Record<string, typeof X> = {
    create: Plus,
    import: Upload,
    settings: Settings2,
    profile: Archive,
    versions: History,
    obsidian: NotebookPen,
    restore: RotateCcw,
    delete: Trash2,
    recall: Clock3,
    review: FileSearch,
    materials: FolderOpen,
    goals: Layers,
    lines: Waypoints,
    "course-notes": BookMarked,
  };
  const Icon = icons[m || ""] || CircleHelp;
  return <Icon size={18} />;
}
function modalTitle(m: Modal) {
  return (
    (
      {
        create: "创建课程",
        import: "导入学习材料",
        settings: "设置",
        profile: "学习档案与反馈",
        versions: "版本与恢复",
        obsidian: "Obsidian 笔记",
        restore: "恢复课程状态",
        delete: "删除课程",
        recall: "找回思路",
        materials: "已导入材料",
        goals: "课程目标看板",
        lines: "课程全貌与主线串讲",
        "course-notes": "课程笔记",
        review: "选择复习资料",
      } as Record<string, string>
    )[m || ""] || ""
  );
}
function busyLabel(key: string) {
  return (
    (
      {
        import: "正在导入材料…",
        generate: "正在分析并生成地图…",
        lesson: "正在生成小课…",
        "lesson-read": "正在保存阅读记录…",
        chat: "AI 正在整理思路…",
        attempt: "正在检查作答…",
        question: "正在生成练习…",
        restore: "正在恢复课程…",
        delete: "正在删除课程…",
        recall: "正在找回对话…",
        "recall-summary": "正在整理学习内容…",
      } as Record<string, string>
    )[key] || "正在保存…"
  );
}

function shortPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}
