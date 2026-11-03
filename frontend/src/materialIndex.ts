import { api } from "./api";
import type { Course } from "./types";

/** Pages with text, and how many already carry the full index (digest, terms, verbatim key lines). */
export function indexProgress(course: Course) {
  return course.material_index ?? { indexed: 0, total: 0 };
}

/** Index the remaining pages batch by batch; each batch is its own AI task and moves progress forward. */
export async function indexAllMaterials(course: Course) {
  // Start from the saved course: a stale page state would send an outdated `indexed` count.
  const fresh = await api.course(course.id);
  let result = { course: fresh, ...indexProgress(fresh) };
  while (result.indexed < result.total) {
    result = await api.indexMaterials(course.id, result.indexed);
  }
  return result.course;
}

export async function generateWithReading(course: Course) {
  await indexAllMaterials(course);
  return api.generate(course.id);
}
