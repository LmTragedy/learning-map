/** Names and labels the app shell shows: dialog titles, busy messages, short data paths. */
export type Modal =
  | "create"
  | "import"
  | "settings"
  | "profile"
  | "versions"
  | "obsidian"
  | "restore"
  | "delete"
  | "recall"
  | "review"
  | "materials"
  | "goals"
  | "lines"
  | "course-notes"
  | "problems"
  | null;

export function modalTitle(m: Modal) {
  return (
    (
      {
        create: "创建课程",
        import: "导入学习材料",
        settings: "设置",
        profile: "学习档案与反馈",
        versions: "版本与恢复",
        obsidian: "Obsidian 笔记",
        restore: "恢复课程状态",
        delete: "删除课程",
        recall: "找回思路",
        materials: "已导入材料",
        goals: "课程目标看板",
        lines: "课程全貌与主线串讲",
        "course-notes": "课程笔记",
        review: "选择复习资料",
        problems: "真题题库",
      } as Record<string, string>
    )[m || ""] || ""
  );
}
export function busyLabel(key: string) {
  return (
    (
      {
        import: "正在导入材料…",
        generate: "正在分析并生成地图…",
        "material-index": "正在逐批建立材料索引…",
        lesson: "正在生成小课…",
        "lesson-read": "正在保存阅读记录…",
        chat: "AI 正在整理思路…",
        attempt: "正在检查作答…",
        question: "正在生成练习…",
        "problem-import": "正在导入并切分题目…",
        "problem-unit": "正在按真题标准出单元题…",
        restore: "正在恢复课程…",
        delete: "正在删除课程…",
        recall: "正在找回对话…",
        "recall-summary": "正在整理学习内容…",
        "generate-lines": "正在生成主线与课程全貌…",
        retell: "正在检查复述…",
      } as Record<string, string>
    )[key] || "正在保存…"
  );
}

export function shortPath(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}
