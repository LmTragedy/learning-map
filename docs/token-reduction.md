# AI token 减量设计

日期：2026-11-03。状态：**第 1–5 期已实施**，下文保留原方案；与方案的差异见"实施记录"。

## 实施记录

| 期 | 实际实现 |
|---|---|
| 1 | `conversation_sessions.PERSISTENT_CHANNELS = {"learning"}`，其余频道 `claim()` 返回 `thread_id=None`（仍占用会话防并发）。`cited_material_context` + `backfill_sources` 只发端点节点和联系引用的页，无引用时回退整门课。`ai_history` 同时接受整门课和引用页两种材料。 |
| 2 | 会话 key 去掉模型名；旧 key 的行按 `logical_key` 取最近线程接续。学习对话续线程时只发 SYSTEM + 新消息；`context_digest`（不含历史的节点上下文 hash，按线程存在 `node.context_digests`）变化时附上新上下文。`ReceiptAI.ask(fresh_prompt=…)`：认领不到线程时改发完整上下文。`request.prompt_chars` 记录每次发送字数。 |
| 3 | `MapDraft.page_digests` 由首次生成地图顺带返回，存为 `page.digest`；无摘要的页用首行兜底（`_local_digest`）。再生成地图：已被节点引用的材料只发摘要，新材料发原文。目标提取：全课摘要 + 每个节点第一来源页原文。 |
| 4 | **简化**：不自动额外调用 AI。Recall「整理学习内容」的最新结果保存为 `node.memories[scope]`（只存类别和内容），作为 `learning_memory` 进入新线程、出题、验收和小课上下文。Recall 页说明已保存；暂不支持手动编辑。 |
| 5 | `node_context(history=False)` 不带记忆、对话和验收，供笔记检查使用；默认改为记忆 + 最近 6 条（原 30 条）。**未做**：提示词顺序调整——Codex 在提示前自带指令前缀，缓存收益无法确认，且会破坏旧历史回收的格式匹配。 |

## 1. 现状（本地数据实测）

| 任务 | 次数 | prompt 总字数 | 单次 | 主要内容 |
|---|---|---|---|---|
| 知识桥回填 `history` / `bridge_history` / `bridge` | 31 | 约 137 万 | 约 11.9 万 | 每批 12 条联系 + **整门课全部页原文** |
| 学习对话 / 出题 / 验收 | 3 | 约 1.2 万 | 3–5 千 | 节点来源页 + 最近 30 条对话 |

浪费来自三处：

1. **整门课原文反复发送**。`course_material_context`（[learning.py:78](../backend/learning.py)）被地图生成、目标提取（[goal_routes.py:37](../backend/goal_routes.py)）、知识桥回填（[bridge_backfill.py:140](../backend/bridge_backfill.py)）调用。回填每批只涉及约 24 个节点，却附带全部页面。
2. **一次性任务也续用旧线程**。`ConversationDirectory.claim` 对所有任务按频道续线程，地图、目标、回填的旧 prompt 留在线程里，第 N 次的输入约为 N 份材料。
3. **对话历史双份**。学习对话续用线程（线程里已有全部历史），`node_context` 又附带最近 30 条对话；笔记检查、出题、小课也复用 `node_context`，同样带着这些对话。

对话接不上：会话 key 含模型名（`provider_key`），换模型就开新线程，且新线程里没有任何前情。

## 2. 原则

- **按需取原文**：默认发摘要和索引，只发与本次任务相关的页面原文。
- **一次性任务不续线程**：只有学习对话需要线程记忆，其余任务每次新开线程，输入有上界。
- **对话靠"记忆摘要 + 最近几条"接续**，不依赖 Codex 线程是否还在。
- 引用校验不受影响：摘录原文的校验已经是对照数据库里的材料页（[learning.py:186](../backend/learning.py)），而不是对照 prompt，所以少发页面不会削弱校验。

## 3. 方案

### 3.1 任务分级：只有对话续线程

| 级别 | 频道 | 线程策略 |
|---|---|---|
| 持续对话 | `learning`（chat、lesson） | 续线程，见 3.4 |
| 一次性 | map、goals、bridge、bridge_history、lines、recall、note_review、assessment/question | **每次新线程**；结果照常保存在 `ai_tasks` |

改动点：`conversation_sessions.py` 的 `claim()` 对一次性频道返回 `thread_id=None`，并且不写回 `ai_conversations.thread_id`。现有的回执和恢复（`read_turn`）按任务里的 `thread_id` 读取，不受影响。

效果：重复生成和回填不再累积，每次的成本固定。

### 3.2 课程材料索引（替代整门课原文）

新增每门课的 `material_index`：每页一条，包含 `material_id, page, week, title_guess, summary(≤80字), terms[≤8]`。

生成方式：**不额外调用 AI**。

- 首次生成地图时仍发送全部原文（只此一次），并让 `MapDraft` 顺带返回每页的 `page_digests`。
- 还没有索引的旧课程，先用本地规则兜底：页内第一行、加粗或标题行、高频术语。等下次生成地图时再替换为 AI 摘要。
- 材料新增或变化时，只为新页面补索引；`require_same_materials` 已能检测材料变化。

使用：

| 任务 | 现在 | 改后 |
|---|---|---|
| 知识桥回填 | 全部页原文 | 本批端点节点 `sources` 引用的页原文（去重，上限约 2 万字） |
| 目标提取 | 全部页原文 | 材料索引 + 节点列表；AI 需要原文佐证时，只用节点已有来源页 |
| 再次生成地图 | 全部页原文 | 材料索引 + 已有节点；**只有新增材料的页**发原文 |
| 首次生成地图 | 全部页原文 | 不变（同时产出索引） |

新增函数 `pages_for(course, node_ids, limit_chars)`，放在 `learning.py`，替代上表中的 `course_material_context` 调用。

预计：回填从每批约 12 万字降到 1–2 万字，降幅约 85–90%，这部分占当前消耗的绝大部分。

### 3.3 `node_context` 拆成按用途组装

现在所有节点任务共用一份大上下文。改为三个组件，各任务按需组合：

| 组件 | 内容 |
|---|---|
| `sources` | 节点来源页原文（现有） |
| `memory` | 节点学习记忆（3.4） |
| `recent` | 最近 k 条对话 |

| 任务 | sources | memory | recent | 其他 |
|---|---|---|---|---|
| 学习对话（续线程时） | 仅当来源变化时发 | 否 | 否 | 只发新消息 |
| 学习对话（新线程时） | 是 | 是 | 6 条 | |
| 出题 / 验收 | 是 | 是 | 0 | 最近 3 次验收 |
| 小课 | 是 | 是 | 0 | 最近 3 节小课 recap |
| 笔记检查 | 是 | 否 | 0 | 笔记全文 |

"来源变化"的判断：把 sources 的 hash 记在 `ai_conversations` 里，hash 相同就不重发。

### 3.4 节点学习记忆（解决接不上）

每个节点、每个资料范围存一份 `memory`（Markdown，≤1500 字），内容包括：已理解的点、卡点、用户用过的说法、已确认的教学偏好。每条注明它依据的对话 id。

- **何时更新**：对话中未被摘要的消息超过 12 条时，用一次小调用把较早的对话合并进记忆（低推理力度）；也可以复用 Recall「整理学习内容」的结果。
- **记忆中只能写对话里实际出现过的内容**，沿用 Recall 的引用校验（拒绝不存在的 id、拒绝角色错配）。
- 用户可在 Recall 中查看和编辑这份记忆。

接续规则：

- 会话 key **去掉模型名**；换模型时用 `thread/resume` 并传入新模型。
- 线程丢失、恢复课程（`restore_epoch` 变化）或资料范围切换后的新线程，第一轮发送 `sources + memory + recent 6`，这样换了线程也能接着聊。

### 3.5 图示

- 图示继续以结构化 JSON 存储（`lesson_visual_schema.py`），**不转 md**。
- 进入上下文时只发 `[{id, title, 一句话说明}]`；修改某张图时才发它的完整 JSON。
- 作图规范（`VISUAL_GUIDANCE`）只在小课生成和图示生成时附带，其他任务不发。

### 3.6 提示词顺序（提高缓存命中）

提供方对相同前缀有输入缓存。把**稳定内容放前面**：固定规则 → 材料索引或来源页 → 记忆 → 易变内容（节点标题列表、本次问题）。现在地图 prompt 把"已有标题"放在材料前面，标题一变，后面的材料就无法命中缓存。

## 4. 实施顺序

| 期 | 内容 | 主要文件 | 预计收益 |
|---|---|---|---|
| 1 | 一次性任务不续线程；回填改为 `pages_for` | `conversation_sessions.py`、`bridge_backfill.py`、`learning.py` | 最大，约 85% 以上 |
| 2 | 会话 key 去掉模型名；对话续线程时不再附带历史 | `conversation_sessions.py`、`learning.py` | 对话轮次成本不随长度增长；换模型能接上 |
| 3 | 材料索引（地图顺带产出 + 本地兜底）；目标和再生成地图使用索引 | `schemas.py`、`learning.py`、`goal_routes.py` | 目标和再生成地图降 80% 以上 |
| 4 | 节点学习记忆 + Recall 中可查看、编辑 | `recall.py`、`learning.py`、前端 Recall | 换线程后对话连续 |
| 5 | `node_context` 按用途组装；提示词顺序调整 | `learning.py`、`note_review.py`、`lessons.py` | 中等 |

## 5. 验证

- 每个 `ai_tasks` 记录 `prompt_chars`；在任务弹层显示本次发送字数，方便对比改前改后。
- 测试：
  - 回填 prompt 只包含端点来源页。
  - 一次性任务每次 `thread_id` 都为 None。
  - 换模型后 `claim()` 返回同一个线程。
  - 续线程时 prompt 不含 `actual_conversations`。
  - 新线程第一轮包含 memory。
- 引用校验测试保持不变并全部通过。

## 6. 风险

- 只发部分页时，AI 可能漏掉其他页的依据。回填和目标任务允许 `uncertain=true` 并提示"可重新分析（完整材料）"，保留一个手动的完整模式。
- 记忆摘要可能失真：只允许写有引用的条目，用户可编辑，原始对话不删除。
- Codex 线程过长时会自行压缩，续线程不发历史后，旧细节可能丢失；记忆和 Recall 是兜底。
