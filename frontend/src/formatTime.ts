/**
 * The one way the app shows a moment in time: "17:15" today, "11月3日 17:15" this year,
 * "2025年11月3日 17:15" before that. `date` drops the clock for day-level facts.
 */
export function formatTime(value: string | number | Date, { date = false }: { date?: boolean } = {}) {
  const moment = new Date(value);
  if (!Number.isFinite(moment.getTime())) return "";
  const now = new Date();
  const today = moment.toDateString() === now.toDateString();
  return moment.toLocaleString("zh-CN", {
    ...(moment.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    ...(today && !date ? {} : { month: "long", day: "numeric" }),
    ...(date ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
}
