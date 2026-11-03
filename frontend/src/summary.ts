// Display-only split of the stored summary ("AI解释：…验收：…本地图仅依据…"); the stored text is unchanged.
export function splitSummary(summary: string) {
  const text = summary.trim();
  const noteAt = text.search(/本地图仅依据|本地图依据|原文见\s*sources/);
  const body = noteAt > 0 ? text.slice(0, noteAt) : text;
  const note = noteAt > 0 ? text.slice(noteAt) : "";
  const checkAt = body.search(/验收[：:]/);
  const explain = (checkAt >= 0 ? body.slice(0, checkAt) : body).replace(/^AI\s*解释[：:]\s*/, "").trim();
  const check = checkAt >= 0 ? body.slice(checkAt).replace(/^验收[：:]\s*/, "").trim() : "";
  return { explain, check, note };
}

