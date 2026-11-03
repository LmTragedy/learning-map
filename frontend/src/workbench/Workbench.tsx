import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Download, NotebookPen, X } from "lucide-react";
import { Button } from "../components/ui/button";
import type { Course, LearningNode } from "../types";
import { MaterialPicker } from "./MaterialPicker";
import { MaterialViewer } from "./MaterialViewer";
import { SourceTabs } from "./SourceTabs";
import type { SourceTab } from "./SourceTabs";
import { useSplitRatio } from "./useSplitRatio";
import type { MaterialView, SourceKind } from "./useWorkbenchState";
import "./workbench.css";

export type LessonTab = { title: string; downloadUrl: string; content: ReactNode; onClose: () => void };

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
 * Side-by-side study space over the map: a lesson and/or a material page as tabs on the left,
 * notes on the right. The node panel with the AI chat stays open beside it.
 */
export function Workbench({ course, node, material, lesson, active, noteOpen, renderNote,
  onActivate, onMaterial, onCloseMaterial, onToggleNote, onCloseAll, onExcerpt, onAsk }: {
  course: Course; node: LearningNode;
  material: MaterialView | null; lesson: LessonTab | null; active: SourceKind; noteOpen: boolean;
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
  const [textMode, setTextMode] = useState(false);
  useEscape(onCloseAll);

  const materialName = material && course.materials.find((entry) => entry.id === material.materialId)?.name;
  const tabs: SourceTab[] = [];
  if (lesson) tabs.push({ id: "lesson", icon: "lesson", label: lesson.title, onClose: lesson.onClose });
  if (material) tabs.push({ id: "material", icon: "material", label: `${materialName || "材料"} · ${material.page}`, onClose: onCloseMaterial });
  // Fall back to whichever tab is still open when the active one was closed.
  const shown: SourceKind | null = active === "lesson" && lesson ? "lesson" : material ? "material" : lesson ? "lesson" : null;

  return <section className="workbench" aria-label="学习工作台">
    <header className="wb-bar">
      <SourceTabs tabs={tabs} active={shown || ""} onActivate={(id) => onActivate(id as SourceKind)}>
        <MaterialPicker course={course} node={node} showLabel={!tabs.length} onOpen={onMaterial} />
      </SourceTabs>
      <div className="wb-tools">
        {shown === "material" && <div className="wb-seg" role="group" aria-label="材料显示方式">
          <button aria-pressed={!textMode} onClick={() => setTextMode(false)}>原文</button>
          <button aria-pressed={textMode} onClick={() => setTextMode(true)} title="可选中文字摘入笔记">文字</button>
        </div>}
        {shown === "lesson" && lesson && <Button asChild size="icon-sm" variant="ghost">
          <a href={`${lesson.downloadUrl}?download=true`} download title="下载 HTML 小课" aria-label="下载 HTML 小课"><Download /></a>
        </Button>}
        <Button size="sm" variant={noteOpen ? "secondary" : "ghost"} aria-pressed={noteOpen} onClick={onToggleNote}><NotebookPen /> 笔记</Button>
        <Button size="icon-sm" variant="ghost" onClick={onCloseAll} title="返回地图 (Esc)" aria-label="返回地图"><X /></Button>
      </div>
    </header>
    <div className="wb-body" ref={container}>
      {shown && <div className="wb-pane" style={noteOpen ? { flex: `0 1 ${ratio * 100}%` } : undefined}>
        {shown === "lesson" ? lesson!.content
          : <MaterialViewer course={course} view={material!} textMode={textMode} onPage={onMaterial} onExcerpt={onExcerpt} onAsk={onAsk} />}
      </div>}
      {shown && noteOpen && <div className="wb-divider" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度" onPointerDown={startDrag} />}
      {noteOpen && <div className="wb-pane wb-note">{renderNote()}</div>}
      {!shown && !noteOpen && <div className="m-auto text-sm text-muted-foreground">从左上角打开材料，或打开笔记。</div>}
    </div>
  </section>;
}
