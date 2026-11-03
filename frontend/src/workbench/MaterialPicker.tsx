import { Plus } from "lucide-react";
import type { Course, LearningNode } from "../types";
import type { MaterialView } from "./useWorkbenchState";

/** The "+" at the end of the tab strip: a native select laid over the button, so keyboard and screen readers get a real picker. */
export function MaterialPicker({ course, node, showLabel, onOpen }: {
  course: Course; node: LearningNode; showLabel: boolean;
  onOpen: (view: MaterialView) => void;
}) {
  const name = (id: string) => course.materials.find((entry) => entry.id === id)?.name || "材料";
  return <label className="wb-add" title="打开课程材料">
    <Plus size={15} aria-hidden />
    {showLabel && <span>打开材料</span>}
    <select aria-label="打开课程材料" value=""
      onChange={(event) => {
        const [materialId, pageNumber] = event.target.value.split(":");
        if (materialId) onOpen({ materialId, page: Number(pageNumber) || 1 });
      }}>
      <option value="" disabled>打开课程材料…</option>
      {!!node.sources.length && <optgroup label="本知识点的出处">
        {node.sources.map((source, index) => <option key={index} value={`${source.material_id}:${source.page}`}>
          {name(source.material_id)} · 第 {source.page} 页</option>)}
      </optgroup>}
      <optgroup label="全部材料">
        {course.materials.map((entry) => <option key={entry.id} value={`${entry.id}:1`}>{entry.name}</option>)}
      </optgroup>
    </select>
  </label>;
}
