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
  Ellipsis,
  GraduationCap,
  GripHorizontal,
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
} from "lucide-react";
import { api } from "./api";
import { CourseMap } from "./CourseMap";
import { recommendedNode } from "./learningNavigation";
import { NodePanel } from "./NodePanel";
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
  | null;
export function App() {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [course, setCourse] = useState<Course | null>(null);
  const [selected, setSelected] = useState<LearningNode>();
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    setCourse(value);
    setCourses((list) =>
      list.map((c) =>
        c.id === value.id
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
    setSelected(
      (old) => value.nodes.find((n) => n.id === old?.id) || recommendedNode(value),
    );
  }, []);
  const eligibleNodes = useMemo(() => {
    if (!course) return [];
    const reviewIds = course.review_scope?.node_ids || [];
    return course.review_scope?.enabled
      ? course.nodes.filter((node) => reviewIds.includes(node.id))
      : course.nodes;
  }, [course]);
  const activeNodes = useMemo(
    () =>
      eligibleNodes.filter(
        (n) =>
          (!directWeek || n.week === directWeek) &&
          (!directNodeId || n.id === directNodeId || n.unlocked),
      ) || [],
    [eligibleNodes, directWeek, directNodeId],
  );
  const reviewUiKey = course?.review_scope?.enabled
    ? `review:${[...course.review_scope.material_ids].sort().join(",")}:${course.review_scope.key}`
    : "course";
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
  const open = async (id: string) => {
    const value = await run("course", () => api.course(id));
    if (value) {
      setCourse(value);
      setSelected(recommendedNode(value));
      setDirectWeek("");
      setDirectNodeId("");
      setDirectQuery("");
    }
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

  return (
    <div className={`app-shell ${navOpen ? "nav-open" : ""}`}>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden />
      <aside className="sidebar" aria-label="课程与工具">
        <div className="brand">
          <span className="brand-mark"><GraduationCap size={17} aria-hidden /></span>
          <div>
            <strong>Learning Map</strong>
            <small>知识地图</small>
          </div>
        </div>
        <div className="side-label">
          <span><Library size={13} aria-hidden /> 我的课程</span> <span>{courses.length}</span>
        </div>
        <div className="course-list">
          {courses.map((c) => {
            const done = course?.id === c.id && course.route ? course.route.completed_count : c.passed_count;
            const total = course?.id === c.id && course.route ? course.route.total : c.node_count;
            return (
              <button
                key={c.id}
                className={`course-item ${course?.id === c.id ? "chosen" : ""}`}
                onClick={() => { setNavOpen(false); void open(c.id); }}
                disabled={busy}
                aria-current={course?.id === c.id ? "page" : undefined}
              >
                <span className="course-row">
                  <BookMarked size={15} aria-hidden />
                  <span className="course-name">{c.title}</span>
                </span>
                <span className="course-meta">
                  <i className="meter" style={{ ["--p" as string]: `${total ? Math.round((done / total) * 100) : 0}%` }} aria-hidden />
                  <small>{done}/{total}</small>
                </span>
              </button>
            );
          })}
        </div>
        <button
          className="new-course"
          onClick={() => {
            setNavOpen(false);
            setTitle("");
            setModal("create");
          }}
        >
          <Plus size={15} />
          新建课程
        </button>
        <div className="sidebar-bottom">
          <button className="side-item" onClick={() => { setNavOpen(false); void openProfile(); }}>
            <Archive size={16} />
            学习档案
          </button>
          <button className="side-item" onClick={() => { setNavOpen(false); void showObsidian(); }}>
            <NotebookPen size={16} />
            Obsidian 笔记
          </button>
          <button className="side-item" onClick={() => { setNavOpen(false); void openSettings(); }}>
            <Settings2 size={16} />
            设置
          </button>
          <div className="service-state" title={health?.ai.reason || undefined}>
            {health?.ai.available && aiEnabled ? <Bot size={15} className="online" aria-hidden /> : <BotOff size={15} aria-hidden />}
            <div>
              <strong>
                {health?.ai.available
                  ? (aiEnabled ? "AI 学习辅助已启用" : "Codex 已找到 · 待启用")
                  : "本地学习模式"}
              </strong>
              <small>
                {health?.ai.available
                  ? "登录状态未检测"
                  : health ? "未找到 Codex，AI 功能不可用" : "正在检测 Codex…"}
              </small>
            </div>
          </div>
        </div>
      </aside>
      <main className="workspace">
        {error && (
          <div className="error-banner">
            <AlertCircle size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="关闭错误">
              <X size={16} />
            </button>
          </div>
        )}
        {course ? (
          <>
            <header className="course-head">
              <button className="icon-btn nav-toggle" onClick={() => setNavOpen(true)} aria-label="打开课程列表">
                <Menu size={18} />
              </button>
              <div className="course-title">
                <h1>{course.title}</h1>
                <div className="course-sub">
                  <span><History size={13} aria-hidden /> 版本 {course.revision}</span>
                  <span><FileText size={13} aria-hidden /> {course.materials.length} 份材料</span>
                  <span><Layers size={13} aria-hidden /> {course.nodes.length} 个知识点</span>
                  {course.route && <span className="course-progress">
                    <i className="meter" style={{ ["--p" as string]: `${course.route.total ? Math.round((course.route.completed_count / course.route.total) * 100) : 0}%` }} aria-hidden />
                    {course.route.completed_count} / {course.route.total} 已掌握
                  </span>}
                </div>
              </div>
              <div className="head-actions">
                {course.review_scope?.enabled ? (
                  <div className="review-chip">
                    <FileSearch size={15} aria-hidden />
                    <span>复习模式 · {course.review_scope.material_ids.length} 份 PDF · AI {course.review_scope.ai_scope === "selected" ? "仅参考所选" : "参考整门课"}</span>
                    <button onClick={openReview}><Pencil size={13} aria-hidden /> 编辑</button>
                    <button onClick={() => void saveReviewScope(false)} disabled={busy}><LogOut size={13} aria-hidden /> 退出</button>
                  </div>
                ) : (
                  <button className="quiet-button head-review" onClick={openReview} disabled={busy}>
                    <FileSearch size={15} /> <span>复习所选 PDF</span>
                  </button>
                )}
                <button
                  className="primary import-button"
                  onClick={() => void openImport()}
                  disabled={busy}
                >
                  <Upload size={15} />
                  <span>导入材料</span>
                </button>
                <div className="menu-anchor">
                  <button
                    className="icon-btn"
                    aria-label="更多课程操作"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <Ellipsis size={18} />
                  </button>
                  {menuOpen && (
                    <>
                      <div className="menu-scrim" onClick={() => setMenuOpen(false)} aria-hidden />
                      <div className="menu" role="menu">
                        {course.materials.length > 0 && (
                          <button
                            role="menuitem"
                            onClick={() => {
                              setMenuOpen(false);
                              void run("generate", () => api.generate(course.id)).then((v) => v && refreshCourse(v));
                            }}
                            disabled={busy || !aiEnabled || !health?.ai.available}
                          >
                            <Sparkles size={15} />
                            {course.nodes.length ? "更新地图" : "生成知识地图"}
                            {(!aiEnabled || !health?.ai.available) && <small>需启用 AI</small>}
                          </button>
                        )}
                        <button role="menuitem" onClick={() => { setMenuOpen(false); setModal("materials"); }}>
                          <FolderOpen size={15} /> 已导入材料 <small>{course.materials.length} 份</small>
                        </button>
                        <hr />
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            void run("snapshot", () => api.snapshot(course.id)).then((v) => v && refreshCourse(v));
                          }}
                          disabled={busy}
                        >
                          <Save size={15} /> 保存版本
                        </button>
                        <button role="menuitem" onClick={() => { setMenuOpen(false); void openVersions(); }}>
                          <History size={15} /> 版本历史
                        </button>
                        <hr />
                        <button role="menuitem" className="danger-text" onClick={() => { setMenuOpen(false); void beginDelete(); }} disabled={busy}>
                          <Trash2 size={15} /> 删除课程…
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </header>
            {course.materials.length > 0 && !course.nodes.length && (
              <div className="generate-strip">
                <Sparkles size={18} aria-hidden />
                <div>
                  <strong>材料已就绪</strong>
                  <span>
                    {aiEnabled
                      ? "分析课程材料并生成知识地图。"
                      : "请先在设置中启用 AI，并确认数据发送说明。"}
                  </span>
                </div>
                <button
                  className="primary"
                  onClick={() =>
                    void run("generate", () => api.generate(course.id)).then(
                      (v) => v && refreshCourse(v),
                    )
                  }
                  disabled={busy || !aiEnabled || !health?.ai.available}
                >
                  <Sparkles size={15} />
                  生成知识地图
                </button>
              </div>
            )}
            <div className="content-grid">
              <section className="graph-area">
                {course.review_scope?.enabled && activeNodes.length === 0 && (
                  <div className="review-empty-note"><FileSearch size={19} /><div><strong>所选 PDF 暂无匹配知识点</strong><span>这份材料当前没有关联到已生成的节点。可以更换复习资料，或退出复习；无需重新导入文件。</span></div></div>
                )}
                <CourseMap
                  key={`${course.id}-${reviewUiKey}`}
                  course={displayCourse || course}
                  prerequisiteNodes={course.nodes}
                  selected={selectedNode}
                  reviewActive={Boolean(course.review_scope?.enabled)}
                  directEntryId={directNodeId}
                  directWeek={directWeek}
                  toolbar={
                    <div className="toolbar-controls">
                      {course.nodes.some((n) => n.week) && <label className="select-wrap">
                        <CalendarDays size={14} aria-hidden />
                        <select
                          aria-label="按周次直达"
                          value={directWeek}
                          onChange={(e) => {
                            setDirectNodeId("");
                            setDirectWeek(e.target.value);
                            setSelected(undefined);
                          }}
                        >
                          <option value="">全部周次</option>
                          {Array.from(
                            new Set(eligibleNodes.map((n) => n.week).filter(Boolean)),
                          ).map((w) => (
                            <option key={w} value={w}>
                              {w}
                            </option>
                          ))}
                        </select>
                      </label>}
                      <label className="search-box">
                        <Search size={15} aria-hidden />
                        <input
                          id="node-search"
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
                        <kbd>Ctrl K</kbd>
                      </label>
                      <datalist id="map-targets">
                        {eligibleNodes.map((n) => (
                          <option key={n.id} value={n.title} />
                        ))}
                      </datalist>
                      {(directQuery || directNodeId || directWeek) && <button
                        className="icon-btn"
                        onClick={() => {
                          setDirectWeek("");
                          setDirectNodeId("");
                          setDirectQuery("");
                          setSelected(recommendedNode(course, eligibleNodes));
                        }}
                        title="清除临时直达"
                        aria-label="清除临时直达"
                      >
                        <RotateCcw size={15} />
                      </button>}
                    </div>
                  }
                  onSelect={(node) => {
                    if (directWeek && node.week !== directWeek) setDirectWeek("");
                    setSelected(node);
                    setSheetOpen(true);
                  }}
                />
              </section>
              <div className={`detail-dock ${sheetOpen ? "open" : ""}`}>
                <button className="sheet-grab" onClick={() => setSheetOpen((v) => !v)} aria-label={sheetOpen ? "收起节点详情" : "展开节点详情"}>
                  <GripHorizontal size={18} aria-hidden />
                </button>
                {selectedNode ? (
                  <NodePanel
                    key={`${selectedNode.id}-${reviewUiKey}`}
                    course={course}
                    node={selectedNode}
                    reviewActive={Boolean(course.review_scope?.enabled)}
                    reviewStrict={Boolean(course.review_scope?.enabled && course.review_scope.ai_scope === "selected")}
                    busy={busy}
                    aiEnabled={aiEnabled}
                    run={run}
                    onRefresh={refreshCourse}
                    onRecall={() => void showRecall()}
                    onRatingSubmitted={() => void onRatingSubmitted()}
                  />
                ) : (
                  <div className="detail-empty">
                    <MousePointerClick />
                    <p>选择一个知识点查看详情</p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="welcome">
            <button className="icon-btn nav-toggle welcome-nav" onClick={() => setNavOpen(true)} aria-label="打开课程列表">
              <Menu size={18} />
            </button>
            <div className="welcome-icon">
              <GraduationCap size={26} aria-hidden />
            </div>
            <span className="eyebrow">本地学习空间</span>
            <h1>
              把知识连起来，
              <br />
              把思路留住。
            </h1>
            <p>从理解课程材料开始，逐步建立自己的知识地图与判断能力。</p>
            <div className="welcome-actions">
              <button
                className="primary"
                onClick={() => {
                  setTitle("");
                  setModal("create");
                }}
              >
                <Plus size={17} />
                创建课程
              </button>
              <button
                className="secondary"
                onClick={() =>
                  void run("sample", api.sample).then(
                    (v) => v && loadCourses(v.id),
                  )
                }
              >
                <FilePlus2 size={17} />
                试用示例课程
              </button>
            </div>
            <small>示例课程明确标注为示例，且从零进度开始</small>
          </div>
        )}
        <footer className="statusbar">
          <span title={health?.data_dir}>
            <ShieldCheck size={14} />
            数据保存在本机 · <span className="data-path">{health?.data_dir ? shortPath(health.data_dir) : "等待本地服务"}</span>
          </span>
        </footer>
        <nav className="tabbar" aria-label="主要功能">
          <button className="on" onClick={() => { setModal(null); setSheetOpen(false); }}><MapIcon size={19} />地图</button>
          <button onClick={openReview} disabled={!course || busy}><FileSearch size={19} />复习</button>
          <button onClick={() => void openProfile()}><Archive size={19} />档案</button>
          <button onClick={() => void openSettings()}><Settings2 size={19} />设置</button>
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
            className={`modal ${["profile", "versions", "obsidian", "recall", "import", "materials"].includes(modal) ? "modal-wide" : ""}`}
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
                                href={`/api/courses/${course.id}/materials/${material.id}/file#page=${page.number}`}
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
                  模型 / 提供方
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
