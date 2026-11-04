import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { Course } from "./types";

/** Pages with text, and how many already carry the full index (digest, terms, verbatim key lines). */
export function indexProgress(course: Course) {
  return course.material_index ?? { indexed: 0, total: 0 };
}

/** The reading run in progress, shown as one notice with page count, elapsed time and 取消. */
export type ReadingRun = { courseId: string; indexed: number; total: number; batch: number; startedAt: number; cancelled: boolean };
let reading: ReadingRun | null = null;
const listeners = new Set<() => void>();
const publish = (next: ReadingRun | null) => { reading = next; listeners.forEach((listener) => listener()); };

export function useReadingRun() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => reading);
}

/** Stops before the next batch; the batch already with the model finishes and its pages are kept. */
export function cancelReading() {
  if (reading) publish({ ...reading, cancelled: true });
}

/** Index the remaining pages batch by batch; each batch is its own AI task and moves progress forward. */
export async function indexAllMaterials(course: Course) {
  // Start from the saved course: a stale page state would send an outdated `indexed` count.
  const fresh = await api.course(course.id);
  let result = { course: fresh, ...indexProgress(fresh) };
  publish({ courseId: course.id, indexed: result.indexed, total: result.total, batch: 1, startedAt: Date.now(), cancelled: false });
  try {
    while (result.indexed < result.total) {
      if (reading?.cancelled) throw new Error(`已取消。已读完的 ${result.indexed} 页会保留，下次从第 ${result.indexed + 1} 页接着读。`);
      const before = result.indexed;
      result = await api.indexMaterials(course.id, result.indexed);
      // Each batch is a model call; a batch that does not move progress forward must not be re-sent forever.
      if (result.indexed <= before) throw new Error("本批索引没有推进进度，已停止继续调用 AI；请刷新后查看任务记录。");
      if (reading) publish({ ...reading, indexed: result.indexed, total: result.total, batch: reading.batch + 1 });
    }
    if (reading?.cancelled) throw new Error(`已取消。材料已全部读完（${result.indexed} 页），没有开始生成地图。`);
    return result.course;
  } finally {
    publish(null);
  }
}

export async function generateWithReading(course: Course) {
  const indexed = await indexAllMaterials(course);
  return api.generate(course.id, indexed.revision);
}
