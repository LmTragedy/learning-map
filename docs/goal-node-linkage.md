# 目标看板 × 知识点联动 — 设计报告

日期：2026-11-03 · 范围：按现有 React/FastAPI/SQLite 结构做增量改造，不新增数据库、不改目标“由用户确认完成”的规则。

## 1. 现状与问题

目标看板现在是一个**独立的模态框**（`GoalBoard.tsx`），入口在顶栏：

| 位置 | 现在显示什么 | 问题 |
|---|---|---|
| 顶栏副标题 `App.tsx:603-609` | 第一个「进行中」目标的标题 + `已验收/终点数` | 只取第一个 doing 目标；≤780px 隐藏；与当前选中节点无关；字号是 meta 级别，基本不会被看到 |
| 顶栏按钮「目标看板」`App.tsx:613` | 打开模态 | 看板会盖住地图和节点面板，学习时不会去开 |
| 节点面板「所属目标」`NodeGoals.tsx` | 包含**本节点作为终点**的目标 chip | **只看 `goal.node_ids`，不看 `route_ids`**。你在学通往目标的先修节点时，这里显示「暂无」——这是“没联动”的直接原因 |
| 地图工具栏「按目标聚焦」`App.tsx:718` | 手动选目标后高亮 `route_ids` | 纯手动，选中节点不会改变它 |
| 子目标 `subtask.node_id` | 节点验收后自动打勾（`goals.py:project_goals`） | 只在看板详情里可见，节点面板上看不到“学完这个会勾掉哪个小目标” |
| 验收通过后 | `course.goals[].progress` 已经被后端重新投影 | 数据变了，但界面上没有任何反馈，除非你自己打开看板 |

结论：**数据其实已经联动了**（`route_ids`、`progress`、`auto_done` 都是后端每次读课程时实时算的），缺的是**在节点上下文里把它呈现出来**。所以第一阶段几乎只需要改前端。

## 2. 设计原则

1. **目标信息跟着节点走**：放在节点面板里（你实际在看的地方），而不是顶栏或模态。
2. **只说和本节点有关的事**：本节点在哪个目标上、处于第几步、学完会推进什么。
3. **变化要被看见**：节点验收/掌握后，在原地提示目标进度的变化。
4. **不越权**：继续只“提示可以确认完成”，目标状态仍由用户确认（遵守 `docs/architecture.md` 的既有约束）；不自动切换用户手动选的地图聚焦。
5. **看板降级为管理页**：增删改、拖拽状态、从材料提取仍在看板里，入口移到侧边栏/底部导航（底部导航已经有「目标」）。

## 3. 方案

### 3.1 新增纯函数 `frontend/src/goalContext.ts`

从 `course` + 当前节点算出“本节点与各目标的关系”，不需要后端改动：

```ts
type NodeGoalRole = "endpoint" | "route" | "subtask";
type NodeGoalContext = {
  goal: Goal;
  roles: NodeGoalRole[];          // 可能同时是终点 + 子目标关联
  step?: { index: number; total: number }; // 在该目标完整路线中的位置
  remaining: number;              // 路线上尚未完成的节点数（= route_ids 中未掌握/未通过的）
  unlocks: Goal["subtasks"];      // 本节点验收后会自动完成的小目标
  next?: LearningNode;            // 本节点之后、路线上第一个已解锁且未完成的节点
  ready: boolean;                 // readyToFinish(goal)
};
export function goalsForNode(course: Course, nodeId: string): NodeGoalContext[];
```

判定规则：
- `endpoint`：`goal.node_ids.includes(nodeId)`
- `route`：`goal.route_ids?.includes(nodeId)` 且不是终点
- `subtask`：`goal.subtasks.some(t => t.node_id === nodeId)`
- 排序：`doing` > `todo` > `done`；同状态内 终点 > 路线 > 子目标。
- `done` 目标默认折叠，只显示数量。

关于“第几步”：`route_ids` 会去掉已完成的中间节点，适合算“还剩几步”，但不适合算“第 k / n 步”。前端可直接用 `course.nodes[].prerequisites` 从终点做祖先闭包，再按 `course.route.stages` 的顺序排序得到完整路线；这一步也是纯函数，可以放进 `frontend/tests/goalContext.test.mjs` 测试（沿用现有 `.test.mjs` 方式）。

### 3.2 节点面板：用「目标上下文卡」替换 `NodeGoals` chip

位置不变（`NodePanel.tsx:181`，标题和笔记按钮下方），但从一行 chip 变成一块可折叠卡片：

```
┌ 🎯 学会 动态规划 · 进行中                       验收 3/5 ▓▓▓░░ ┐
│ 本节点：通往终点的第 4 / 7 步 · 还剩 3 步                      │
│ 验收通过后会自动完成：「能写出背包状态转移」                    │
│ 下一步 → 区间 DP                                     [进入]     │
│ [在地图上显示路线]  [打开目标]                                  │
└───────────────────────────────────────────────────────────────┘
  另有 1 个目标经过这里 ▸
```

- 只有一个相关目标时直接展开；多个时展开第一个（进行中），其余折叠成一行。
- 本节点不在任何目标上：只保留原来的「加入目标…」小下拉，不占空间。
- 「在地图上显示路线」= `setMapGoal(goal.id)`，复用现有 `focusIds` 高亮，不新增地图逻辑。
- 「下一步 → 进入」= 复用 App 里的选中节点逻辑；严格复习范围外的节点按 `GoalDetail` 现有规则禁用并提示。
- `ready` 时显示「条件已满足，可以确认完成」+ 按钮，点击打开看板并定位该目标（`setGoalFocus` + `setModal("goals")`），确认动作仍在看板里完成。

`NodePanel` 需要新增一个回调 `onFocusGoal(goalId)`，与已有 `onOpenGoal` 并列。

### 3.3 进度变化反馈（“到这个知识点，看板自动变化”的可见部分）

在 App 刷新课程的入口（`refreshCourse` / `act`）里，比较刷新前后的 `goals[].progress` 与 `subtasks[].auto_done`，有变化时在节点面板顶部给一条**原地提示**（不需要引入 toast 库，用现有卡片样式即可，几秒后可关闭）：

- 「目标『学会 动态规划』验收 3/5 → 4/5」
- 「小目标『能写出背包状态转移』已自动完成」
- 「目标所有条件已满足，可以去确认完成」

纯前端 diff 函数 `goalProgressDiff(before, after)` 同样放进 `goalContext.ts` 并测试。

### 3.4 地图联动（克制）

- 不自动改变用户手动选的「按目标聚焦」。
- 若当前有聚焦目标而选中节点不在其路线上，在下拉旁显示一个淡色提示「当前节点不在该目标路线上」。
- 若没有聚焦目标，选中节点时给其所在**进行中目标**的路线节点加轻微描边（比 `focusIds` 的强淡化弱得多），这样点到哪个节点，地图上就能看到它属于哪条目标路线。实现上给 `MapView` 增加一个可选 `hintIds`，只改样式不改透明度。

### 3.5 顶栏收缩

- 删除顶栏副标题里的「当前目标」按钮（信息已经进入节点面板）。
- 「目标看板」按钮移到左侧导航（桌面）——底部导航（移动）已经有「目标」入口，两端保持一致。
- 顶栏保留课程名、版本、材料、掌握进度、复习模式、导入、更多。

## 4. 分阶段实施

| 阶段 | 内容 | 涉及文件 | 后端改动 |
|---|---|---|---|
| P1 | `goalContext.ts` + 测试；目标上下文卡替换 `NodeGoals`；顶栏收缩 | `goalContext.ts`（新）、`NodeGoals.tsx`→重写、`NodePanel.tsx`、`App.tsx`、`frontend/tests/goalContext.test.mjs`（新） | 无 |
| P2 | 进度变化提示 | `App.tsx`、`NodePanel.tsx`、`goalContext.ts` | 无 |
| P3 | 地图 `hintIds` 弱高亮 + 不在路线提示 | `MapView.tsx`、`CourseMap.tsx`、`App.tsx`、`graph.css` | 无 |
| 可选 P4 | 若前端排序与后端路线不一致，在 `project_goals` 中额外投影 `path_ids`（完整有序路线，含已完成），前端改为直接读取 | `backend/goals.py`、`types.ts`、`tests/test_goal_route.py` | 只读投影，不存储，无迁移 |

P1 完成就能解决“到这个知识点没反应”和“放上面不会看”两个核心问题；P2、P3 是让变化更明显。

## 5. 不做的事

- 不自动把目标移到「已完成」——与现有“目标达成由你确认”的约束一致。
- 不根据当前节点自动改目标状态（例如自动设为进行中）。
- 不把看板做成常驻侧栏：右侧已经是节点面板 + 工作台，再加一栏会挤压地图；看板继续作为管理页。

## 6. 验证

- 单测：`goalsForNode`（终点/路线/子目标/无关/多目标排序/已完成节点不计入剩余）与 `goalProgressDiff`。
- 现有 `tests/test_goal_route.py` 保持通过（P4 时补 `path_ids` 用例）。
- 浏览器：用合成课程建一个 3 层先修链的目标，依次进入先修节点 → 检查卡片显示“第 k 步”；验收通过 → 检查原地提示与自动勾选的小目标；严格复习模式下范围外的“下一步”被禁用。
