import type { Course, Line } from "./types";

/** Metro-style line colours, readable on the dark graph background. */
export const LINE_COLORS = ["#4ade80", "#60a5fa", "#f59e0b", "#f472b6", "#a78bfa", "#2dd4bf", "#f87171", "#facc15"];

export const lineColor = (line: Pick<Line, "color">) => LINE_COLORS[line.color % LINE_COLORS.length];

/** For each node, the lines it sits on, in line order. */
export function linesByNode(course: Course) {
  const map = new Map<string, Line[]>();
  for (const line of course.lines || []) for (const id of line.node_ids) map.set(id, [...(map.get(id) || []), line]);
  return map;
}

/** For each pair "a>b" of consecutive stations, the line that runs along it. */
export function lineSegments(course: Course) {
  const map = new Map<string, Line>();
  for (const line of course.lines || [])
    line.node_ids.forEach((id, index) => {
      const next = line.node_ids[index + 1];
      if (next) { map.set(`${id}>${next}`, line); if (!map.has(`${next}>${id}`)) map.set(`${next}>${id}`, line); }
    });
  return map;
}

export function linePercent(line: Line) {
  const { done, total, ratio } = line.progress;
  return Math.round((ratio ?? (total ? done / total : 0)) * 100);
}
