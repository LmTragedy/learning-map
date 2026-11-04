import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BookOpen, ChevronLeft, CircleHelp, Columns2, Download, NotebookPen } from "lucide-react";
import { Button } from "../components/ui/button";
import type { Course, LearningNode } from "../types";
import { MaterialPicker } from "./MaterialPicker";
import { MaterialViewer } from "./MaterialViewer";
import { SourceTabs } from "./SourceTabs";
import type { SourceTab } from "./SourceTabs";
import { useSplitRatio } from "./useSplitRatio";
import { SelectionToNote } from "../SelectionToNote";
import type { MaterialView, SourceKind } from "./useWorkbenchState";
import "./workbench.css";

/** The two study modes. `downloadUrl` and `lessonTitle` describe the lesson being read, when there is one. */
export type StudyViews = { lesson: ReactNode; practice: ReactNode; downloadUrl?: string; lessonTitle?: string };

const SIDE_BY_SIDE_KEY = "learning-map:workbench-side-by-side";

/** Whether the study mode and the material page share the screen, remembered per viewer. */
function useSideBySide() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(SIDE_BY_SIDE_KEY) === "on"; } catch { return false; } });
  const toggle = () => setOn((current) => {
    try { localStorage.setItem(SIDE_BY_SIDE_KEY, current ? "off" : "on"); } catch { /* per-viewer convenience only */ }
    return !current;
  });
  return [on, toggle] as const;
}

function useEscape(onEscape: () => void) {
  const latest = useRef(onEscape);
  useEffect(() => { latest.current = onEscape; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector(".modal-scrim, .cm-tooltip-autocomplete, [data-radix-popper-content-wrapper]")) latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Study space over the map: the lesson or practice mode and/or a material page (one at a time,
 * or side by side) on the left and notes on the right. The node panel with the AI chat stays
 * open beside it.
 */
export function Workbench({ course, node, material, study, active, noteOpen, renderNote,
  onActivate, onMaterial, onCloseMaterial, onToggleNote, onCloseAll, onExcerpt, onAsk }: {
  course: Course; node: LearningNode;
  material: MaterialView | null; study: StudyViews | null; active: SourceKind; noteOpen: boolean;
  renderNote: () => ReactNode;
  onActivate: (kind: SourceKind) => void;
  onMaterial: (view: MaterialView) => void;
  onCloseMaterial: () => void;
  onToggleNote: () => void;
  onCloseAll: () => void;
  onExcerpt: (block: string) => void;
  onAsk: (text: string) => void;
}) {
  const { ratio, container, startDrag } = useSplitRatio();
  const {ratio:pairRatio,container:pairContainer,startDrag:startPairDrag} = useSplitRatio("learning-map:workbench-pair-ratio");
  const [textMode, setTextMode] = useState(false);
  const [sideBySide, toggleSideBySide] = useSideBySide();
  // The study mode last picked, so it stays on screen beside the material when that tab is active.
  const [studyMode, setStudyMode] = useState<"lesson" | "practice">(active === "practice" ? "practice" : "lesson");
  if (active !== "material" && active !== studyMode) setStudyMode(active);
  useEscape(onCloseAll);

  const materialName = material && course.materials.find((entry) => entry.id === material.materialId)?.name;
  const tabs: SourceTab[] = [];
  if (material) tabs.push({ id: "material", icon: "material", label: `${materialName || "材料"} · ${material.page}`, onClose: onCloseMaterial });
  // Fall back to whichever view is still open when the active one was closed.
  const shown: SourceKind | null = active === "material" && material ? "material"
    : study ? (active === "practice" ? "practice" : "lesson")
      : material ? "material" : null;
  const paired = sideBySide && !!study && !!material;
  const studyShown = paired ? studyMode : shown === "material" ? null : shown;
  const materialShown = paired || shown === "material";
  const mode = (kind: "lesson" | "practice", label: string, Icon: typeof BookOpen) =>
    <button role="tab" aria-selected={studyShown === kind} onClick={() => onActivate(kind)}><Icon size={14} aria-hidden />{label}</button>;
  // Selected text in any pane can go straight into the note, labelled with where it came from.
  const studyLabel = studyShown === "practice" ? `练习验收 · ${node.title}` : study?.lessonTitle ? `小课「${study.lessonTitle}」` : `小课 · ${node.title}`;
  const studyView = studyShown && <SelectionToNote label={studyLabel} onExcerpt={onExcerpt} onAsk={onAsk}>
    {studyShown === "practice" ? study!.practice : study?.lesson}
  </SelectionToNote>;
  const materialView = material && <SelectionToNote label={`${materialName || "材料"} 第 ${material.page} 页`} onExcerpt={onExcerpt} onAsk={onAsk}>
    <MaterialViewer course={course} view={material} textMode={textMode} onPage={onMaterial} />
  </SelectionToNote>;

  return <section className="workbench" aria-label="学习工作台">
    <header className="wb-bar">
      <button className="wb-back" onClick={onCloseAll} title="返回地图 (Esc)"><ChevronLeft size={16} aria-hidden />地图</button>
      <span className="wb-sep" aria-hidden />
      <div className="wb-mode" role="tablist" aria-label="学习方式">
        {mode("lesson", "小课", BookOpen)}
        {mode("practice", "练习验收", CircleHelp)}
      </div>
      <SourceTabs tabs={tabs} active={materialShown ? "material" : ""} onActivate={(id) => onActivate(id as SourceKind)}>
        <MaterialPicker course={course} node={node} showLabel={!tabs.length} onOpen={onMaterial} />
      </SourceTabs>
      <div className="wb-tools">
        {study && material && <Button size="sm" variant="ghost" aria-pressed={sideBySide} onClick={toggleSideBySide}
          title={sideBySide ? "改为一次看一个" : "材料和小课左右并排"}><Columns2 /> 并排</Button>}
        {materialShown && <div className="wb-seg" role="group" aria-label="材料显示方式">
          <button aria-pressed={!textMode} onClick={() => setTextMode(false)}>原文</button>
          <button aria-pressed={textMode} onClick={() => setTextMode(true)} title="可选中文字加入笔记">文字</button>
        </div>}
        {studyShown === "lesson" && study?.downloadUrl && <Button asChild size="icon-sm" variant="ghost">
          <a href={`${study.downloadUrl}?download=true`} download title="下载 HTML 小课" aria-label="下载 HTML 小课"><Download /></a>
        </Button>}
        <Button size="sm" variant="ghost" aria-pressed={noteOpen} onClick={onToggleNote}><NotebookPen /> 笔记</Button>
      </div>
    </header>
    <div className="wb-body" ref={container}>
      {shown && <div className="wb-pane" style={noteOpen ? { flex: `0 1 ${ratio * 100}%` } : undefined}>
        {paired
          ? <div className="wb-split" ref={pairContainer}>
            <div className="wb-pane" style={{ flex: `0 1 ${pairRatio * 100}%` }}>{studyView}</div>
            <div className="wb-divider" role="separator" aria-orientation="vertical" aria-label="拖动调整学习和材料的宽度" onPointerDown={startPairDrag} />
            <div className="wb-pane">{materialView}</div>
          </div>
          : materialShown ? materialView : studyView}
      </div>}
      {shown && noteOpen && <div className="wb-divider" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度" onPointerDown={startDrag} />}
      {noteOpen && <div className="wb-pane wb-note">{renderNote()}</div>}
      {!shown && !noteOpen && <div className="m-auto text-sm text-muted-foreground">选择小课或练习验收，或打开一页材料。</div>}
    </div>
  </section>;
}
