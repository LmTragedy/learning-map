import type { Course } from "./types";

type BridgeBackfillProgress = { batch: number; total: number; remaining: number };

export async function backfillBridgeBatches({
  course,
  batchSize,
  countGaps,
  backfill,
  isCurrent,
  onProgress,
  onBatch,
}: {
  course: Course;
  batchSize: number;
  countGaps: (course: Course) => number;
  backfill: (courseId: string, revision: number) => Promise<Course>;
  isCurrent: () => boolean;
  onProgress: (progress: BridgeBackfillProgress) => void;
  onBatch: (course: Course) => void;
}) {
  let latest = course;
  let remaining = countGaps(course);
  const total = Math.ceil(remaining / batchSize);

  for (let batch = 1; batch <= total && remaining > 0; batch += 1) {
    if (!isCurrent()) return;
    onProgress({ batch, total, remaining });
    const updated = await backfill(course.id, latest.revision);
    if (!isCurrent()) return;

    const nextRemaining = countGaps(updated);
    if (nextRemaining >= remaining) throw new Error("本批没有减少待补充联系，已停止后续批次；请刷新后重试。");
    latest = updated;
    remaining = nextRemaining;
    onBatch(updated);
  }
}
