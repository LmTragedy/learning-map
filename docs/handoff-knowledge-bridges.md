# 交接：知识桥 + 以完整关系图为中心的改造

日期：2026-11-03。用户已确认方案（“没问题改”）。**四期均已实现并通过测试**，实施记录见 [knowledge-bridges-implementation.md](knowledge-bridges-implementation.md)。下面的分期保留作设计依据。

## 设计依据（先读）
- 知识桥与整体图方案：https://claude.ai/artifact/2Dh33Crh41eKdyXydHRmR8
- 系统关系总图（现状 / 改后）：https://claude.ai/artifact/CUheEacCH9dxmjWgR2Xt6B
- 早期体验问题报告：https://claude.ai/artifact/P5e8vQivHXXBzapBScyfBq

## 已确认的决定
1. **完整关系图保留并作为中心**（用户明确喜欢它）。不要再合并成“三档缩放的新地图”；方案报告第 6 节的“一张新地图”以系统关系总图为准：完整关系图 + 线上标签 + 按主线上色 + 拉远看整体。
2. “学习主线”标签改为关系图旁的**同步侧边列表**（点列表定位到图，点图列表跟随）。
3. 近看（两点之间的知识桥）和远看（主线、换乘站、整体、串讲）**都要做**。
4. 目标 = 图上选终点站，路线亮在图上；目标看板保留为列表。
5. 笔记可挂在 站 / 桥 / 主线。进度只有一个来源：块 → 站 → 主线 → 课程。
6. 尚未回答、按默认处理：解锁先保持按整个节点（桥只解释 + 强度“必需/建议/拓展”用于推荐）；每个知识点拆 3–6 块；先做近看再做远看。

## 实施分期（来自方案报告第 8 节，按图中心调整；均已完成）
1. **桥的数据 + 迁移 + 节点页**：节点新增 pieces（定义/记号/性质/方法/例子 + 出处）和 steps；边下挂 bridges（from_piece, to_step, how, if_missing, strength, check{question,answer}, sources）；74 条旧边迁移为每条一座“必需”桥；AI 生成与“补充知识桥”（替换 `backend/relation_backfill.py` 的补充说明）；节点栏 BridgeCard 改为显示桥；修复 `backend/relations.py` `relations_for_node` 把占位文字“旧版关系未记录解释。”发给 AI 的问题。
2. **检验与回溯**：检验题作答记录到块的掌握状态；练习失败时判断缺哪座桥并在图上标红、一键回上一站。
3. **关系图升级**：线上标签（类型 · 用到的块，缩放够大才显示），主线着色、换乘站大圈，点线上标签打开桥详情（替代 RelationPanel），学习主线变侧边同步列表。
4. **整体与联动**：AI 生成主线（名称、一句话目标、站序、终点能力、串讲）；拉远只显示主线与换乘站；学完一条线的串讲 + “自己讲一遍”；课程全貌；目标路线画在图上；笔记挂桥/线；统一进度。

## 当前代码状态
- 分支 master，**所有改动未提交**（含本会话之前就存在的大量未跟踪文件）。用户未要求提交。
- 改造前已有：体验修复第一批、命名多笔记（`course.notes` + `personal_note_title`）、学习工作台（`frontend/src/Workbench.tsx`）、Notion 式编辑工具（`NoteToolbar.tsx`、`noteFormatting.ts`、`liveMarkdown.ts`）、目标拖拽/小目标关联节点/目标优先推荐（`backend/route.py`）、字号阶梯（`index.css` 的 `.t-page/.t-section/.t-item/.t-label/.t-meta`）。
- 知识桥改造新增：
  - 后端：`bridges.py`（块、步骤、桥、旧边迁移投影、自检）、`bridge_backfill.py`（AI 补充知识桥，取代已删除的 `relation_backfill.py`）、`lines.py`（主线与统一进度）、`lines_ai.py`（主线生成、串讲评价）、`line_routes.py`。
  - 前端：`BridgeDetail.tsx`、`BridgeEditors.tsx`、`BridgeGaps.tsx`（缺桥标红与回上一站）、`LinesPanel.tsx`（课程全貌）、`AnchoredNotes.tsx`（桥/主线笔记）、`bridges.ts`、`lines.ts`、`goalContext.ts`。`RelationPanel.tsx`、`RelationsSection.tsx` 已删除。
  - 测试：`tests/test_bridges.py`、`test_lines.py`、`test_lines_ai.py`，`frontend/tests/bridges.test.mjs`、`goalContext.test.mjs`。
- 关键位置：关系图 `frontend/src/MapView.tsx` + `graphLayout.ts`；图旁同步列表 `CourseMap.tsx` 的 `RouteList`；节点栏 `NodePanel.tsx` + `BridgeCard.tsx`；关系数据 `backend/relations.py`、`learning.py`、`schemas.py`。
- 交接后修复：`CourseMap.tsx` 中图上选中后展开分组的 effect 原本同步调用 setState（lint 报错），已改到 requestAnimationFrame 里并在浏览器验证。
- 启用新版：重启 8741 的 `start.cmd` 后刷新；旧课程先“用 AI 补充知识桥”，再在“课程全貌”生成主线。真实模型生成内容的质量尚未验收（浏览器测试用的是本地假 AI）。
- 可能的后续：用户确认后提交；之前按默认处理的三项（按整节点解锁、每点 3–6 块、先近后远）如需改动由用户提出。

## 验证命令
```
cd frontend && npx tsc -p tsconfig.app.json --noEmit && npx eslint src && node --test tests/*.test.mjs && npm run build
cd .. && .venv/Scripts/python.exe -m pytest tests -q
```
最近结果（2026-11-03 改造完成后）：后端 183 通过，前端 35 通过，tsc 与 build 通过，lint 仅 2 个旧警告（badge/button）。注意 `npx tsc -p .` 不检查任何文件，要用 `tsconfig.app.json`。

## 注意事项
- **Codex 也在这个仓库工作**（AI 笔记检查：`backend/note_review.py`、`useNoteReview.ts`、`NoteReviewPanel.tsx`、`noteReviewTypes.ts`、`LiveMarkdownEditor` 的 `onReady/onTab`）。不要改这些；它依赖 Markdown 字符偏移，所以笔记编辑器必须保持 CodeMirror + Markdown。
- 用户的服务在 8741（`start.cmd`），后端改动需重启它。浏览器验收用临时 `.claude/launch.json` 起 8742，数据目录指向 scratchpad，**不要碰用户真实数据**；用完删除 launch.json。
- 在 Windows bash 里用 heredoc 写含 `\\n` 或中文引号的 Python 容易出错，改用 Write 写脚本文件再运行。
- 回复用户用中文；用户偏好：直接做完、最后验收，少提问；报告带图。
