import { ChevronLeft, ChevronRight } from "lucide-react";
import { materialFileUrl } from "../api";
import type { Course } from "../types";
import { MaterialText } from "./MaterialText";
import type { MaterialView } from "./useWorkbenchState";

/** One page of a course material, as the original PDF or as extracted text, with a floating pager. */
export function MaterialViewer({ course, view, textMode, onPage, onExcerpt, onAsk }: {
  course: Course; view: MaterialView; textMode: boolean;
  onPage: (view: MaterialView) => void;
  onExcerpt: (block: string) => void;
  onAsk: (text: string) => void;
}) {
  const material = course.materials.find((entry) => entry.id === view.materialId);
  if (!material) return <div className="m-auto text-sm text-muted-foreground">这份材料已不在课程中。</div>;
  const page = material.pages.find((entry) => entry.number === view.page);
  const label = `${material.name} 第 ${view.page} 页`;
  const total = material.pages.length;
  return <div className="wb-material">
    {textMode
      ? <MaterialText text={page?.text || ""} uncertain={Boolean(page?.uncertain)} label={label} onExcerpt={onExcerpt} onAsk={onAsk} />
      : <iframe key={`${view.materialId}:${view.page}`} title={label} src={materialFileUrl(course.id, view.materialId, view.page)} />}
    <div className="wb-pager" role="group" aria-label="翻页">
      <button aria-label="上一页" disabled={view.page <= 1} onClick={() => onPage({ ...view, page: view.page - 1 })}><ChevronLeft size={15} /></button>
      <span>{view.page} / {total || "?"}</span>
      <button aria-label="下一页" disabled={view.page >= total} onClick={() => onPage({ ...view, page: view.page + 1 })}><ChevronRight size={15} /></button>
    </div>
  </div>;
}
