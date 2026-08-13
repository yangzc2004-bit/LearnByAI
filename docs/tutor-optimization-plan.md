# Tutor 模块优化实施计划

> 状态：已评审（诊断逐条对照代码核实通过）
> 前置文档：`docs/tutor-revise-decoupling-plan.md`（Revise 面板相关）、`docs/DEVELOPMENT.md`
> 参考原型：AlphaXiv 问答系统（借鉴：行内引用 + 点击跳回正文 + 分块 grounding；规避：慢 tooltip、生成时锁滚动）

## 0. 已拍板决策

| 决策点 | 结论 |
|---|---|
| 引用粒度 | **section 粒度**（数据、锚点、校验函数全部现成）；段落级引用列入 backlog |
| 历史范围 | 「本章 / 本课程全部」两级，API 设计为 `chapterId`/`courseId` 双参数，未来加「全局」零后端改动 |
| 回答长度 | `maxTokens: 4096` + **复用现有续写机制**（`continueOnOutputLimit`），不新写续写逻辑 |
| 教材外知识 | **教材为主 + 外部补充显式标注**（见 P3-1 规则） |
| Mock 模式 | **不做 mock 适配**：不新增 mock citation fixture，新特性在 mock 模式下不可见属预期。彻底移除 mock 代码是涉及 `test:phase-gate` 的独立任务，不在本计划范围 |

## 1. 总体目标

1. **治「怪」**：问题不重复传入、tutor 真正读到章节正文、长回答不被截断报错。
2. **治「没历史」**：历史跨章节可见、失败对话可恢复、标题/摘要生效、切章不串对话。
3. **差异化核心**：回答带行内引用 chip，悬停看原文、点击跳回正文、可返回（对标 AlphaXiv ②）。
4. **打磨**：上下文感知建议问题、历史截断透明化、术语表按需注入、流式错误路径统一。

### 依赖关系

```
Phase 0（正确性）──所有体验的地基，必须先做
   ↓
Phase 1（失败可见 + 断流保障）──F2-2「失败落库」的前置
   ↓
Phase 2（历史全局化）──与 Phase 3 可并行
Phase 3（Grounding + 行内引用）──依赖 P0-2 注入的正文，最大头
   ↓
Phase 4（打磨）
```

---

## 2. Phase 0 — 正确性修复

### P0-1 去重当前问题

**改动**：`src/lib/hooks/useTutor.ts` `streamAnswer`

现状：`ask()` 把新 user 消息 append 进 `annotation.messages` 后传入 `streamAnswer`，后者第 78 行把整个 `messages` 当 `history` 传给服务端；prompt 又单独拼接 `用户问题：${input.question}`（`annotationTutor.ts:75`）→ 当前问题出现两次。

修法（单点修复，同时覆盖 `ask()` 与 `regenerateLast()` 两条路径）：

```ts
history: annotation.messages
  .filter((message) => message.id !== pendingId)
  .slice(0, -1) // 去掉刚 append 的当前 user 问题
  .map(({ role, content }) => ({ role, content })),
```

验收：真实模式下提问，观察 job events / 请求 prompt，当前问题只出现在 `用户问题：` 一处。

### P0-2 注入章节正文 + 修正摘要字段

**改动**：`src/app/api/annotations/route.ts`（两处 context 组装：:81、:165）、`src/lib/prompts/annotationTutor.ts`

1. **修正错位字段**：`chapterSummary: chapter?.contract?.summaryForNext` 的语义是「供下一章引用的摘要」，却标为「本章已讲内容概要」。改为**确定性派生**（不调 LLM）：
   - `chapterSummary` = `chapter.description`（已有字段，prompt 中本就标注为「章节摘要」）+ 各节标题列表，如 `本章分 4 节：§1 定义与背景、§2 傅里叶级数、...`。
   - 原 `summaryForNext` 只保留其本义：作为「本章为下一章铺垫」的背景信息单独注入（可选），不再冒充本章概要。

2. **分层正文注入**（对应 AlphaXiv ⑤ 的 chunk 注入，节流版）：
   - **锚定问题**（`selectedText` + `sectionId` 存在）：注入该 section 的**全文 content**（硬上限 ~4000 字，超出截断并标注 `[已截断]`）+ 全章「章节地图」。
   - **泛问**（chapter 级）：注入「章节地图」（全部节标题 + 每节 `purpose`）+ 章节导言（`description`）。v1 不注入整章正文；v1.1 可选做关键词重叠检索（问题 vs 各节 content，取 top-2 节注入，纯确定性、无 LLM 开销）。

3. **章节地图格式**（同时是 P3 引用标记的节号索引，两者共用一份）：
   ```
   ## 章节地图
   当前章节《信号与系统》共 4 节：
   - §1 信号的定义与分类：建立信号的数学表示。
   - §2 线性时不变系统：…
   ```
   节号 = 该节在 `chapter.sections` 按 `order` 排序后的 1-based 序号，映射到 `section.id`。

4. **术语表暂保持全量注入**（按需注入移到 P4-3），但必须与上下文预算联动：注入总长超限时，优先裁术语表再裁正文（术语表是字典，正文是依据）。

**prompt 改动**：`annotationTutor.ts` 的 `contextSection` 增加 `章节地图`/`正文摘录` 两个入口；`AnnotationTutorInput.context` 类型扩展 `sectionMap`、`sectionContent`。

验收：anchored 提问时 prompt 含选中段所在节全文；泛问含全章节地图；`本章已讲内容概要` 字段不再输出 `summaryForNext` 内容。

### P0-3 长回答不再截断报错

**改动**：`src/lib/maol/client.ts` `askTutor`（:1145-1161）

关键事实：续写机制**已存在**于 `src/lib/ai.ts`（`continueOnOutputLimit`、`maxContinuationSegments`、内置 continuation prompt 覆盖 chat/responses 两种协议、去重拼接 `appendContinuation`），`dispatcher.ts` 已透传，章节生成已在用（`chapterAuthorHarness.ts:117`）。**不新写任何续写逻辑**，只启用：

```ts
// 无硬编码预算：预算走 TUTOR_MAX_TOKENS → AI_MAX_TOKENS（默认 32768）配置链，
// 续写让上限弹性化，而不是截断悬崖。
continueOnOutputLimit: true,
maxContinuationSegments: 2, // ai.ts normalize 后最小为 2（clamp），即最多 32768×3 段
```

**超时三层必须重配**（续写 = 多次模型调用，原预算必然不够）：

| 常量 | 位置 | 现值 | 新值 |
|---|---|---|---|
| `TUTOR_TIMEOUT_MS` | `maol/client.ts:69` | 60s | 120s |
| `TUTOR_ROUTE_TIMEOUT_MS` | `annotations/route.ts:12` | 65s | 125s |
| `TUTOR_REQUEST_TIMEOUT_MS` | `useTutor.ts:10` | 70s | 130s |

保持 模型 < 路由 < 客户端 的严格递进，避免「模型还在续写、路由已砍、客户端未感知」。生产环境建议 `TUTOR_MAX_TOKENS=8192`（弹性 ≈24K，覆盖一切推导）。

验收：构造长推导问题，回答 >2048 token 时自动续写不报错；超时三层关系不变。

---

## 3. Phase 1 — 失败可见与断流保障

> 本阶段是 F2-2「失败落库」的前置：没有终结事件保障，断流连「失败」都不会触发。

### P1-1 SSE 终结事件保障

**改动**：`src/lib/hooks/useTutor.ts` `askTutorStreaming`

现状：若流在收到 `done`/`error` 前断开（断网、服务端被杀），读取循环正常退出，`saved = undefined`，UI **静默显示半截答案、不报错、不落库**。

修法：加 `receivedTerminalEvent` 标志，`done`/`error` 分支置 true；循环 + `flush` 结束后：

```ts
if (!receivedTerminalEvent) {
  throw new Error("Tutor stream ended without a terminal event.");
}
```

落入既有 catch → 明确 UI 错误状态（对应「断流落到明确 UI 状态」）。同时统一：catch 分支中 `updateMessageContent(draft, pendingId, () => message)` 用**替换**语义，与 token 的追加语义不一致，改为追加 `\n\n（已中断：{message}）`，保留已生成内容。

### P1-2 失败对话也落库

**改动**：`src/app/api/annotations/route.ts` `handleStreamingPost` 的 catch 分支

修法：catch 中若 `anchor.annotation` 存在，服务端**重建**（不用客户端 draft，避免混入 pendingId 半截消息）并落库：

```ts
const failed = {
  ...anchor.annotation,
  messages: [
    ...stripClientOnlyMessages(anchor.annotation).messages,
    { id: crypto.randomUUID(), role: "assistant", content: `⚠️ ${tutorErrorMessage(error)}` },
  ],
};
await saveServerAnnotation(failed, request); // 失败也可见，可点重试
```

- 「重试」复用现有 `regenerateLast()`（它会重问最后一条 user 消息），无需新按钮逻辑。
- quota 语义不变：`withQuotaConsumption` 失败自动释放，失败落库不消耗 quota。
- 注意 `withDeadline` 只负责 reject，底层模型调用可能仍在跑——失败落库与「模型后来成功」并存时，重试会生成第二条回答，可接受。

**非流式 POST** 的 catch 同样处理（:118-123）。

验收：断网/超时后刷新页面，失败线程出现在历史列表，打开后可点「重答」。

---

## 4. Phase 2 — 历史全局化

### P2-1 历史按课程查询

**改动**：`src/app/api/annotations/route.ts` GET、`src/lib/serverStore.ts` `listServerAnnotations`

- GET 签名：`?chapterId=...` 或 `?courseId=...`（至少一个，缺省 400）。二者独立生效，未来「全局」只需 UI 加 tab。
- `listServerAnnotations(filters: { chapterId?: string; courseId?: string }, request)`：
  - Supabase：条件 `.eq("chapter_id", ...)` / `.eq("course_id", ...)`（`course_id` 列已存在，`saveServerAnnotation` 已在写）。**存量行 `course_id` 可能为 null**，course 级查询查不到属预期，可选做一次回填迁移（由 `chapter_id` join `chapters` 表）。
  - 本地 fallback：`localAnnotations` 已有 `courseId`，直接过滤。
- 排序保持 `created_at` 升序。

### P2-2 前端历史面板两级切换

**改动**：`src/lib/hooks/useTutor.ts`（`reloadAnnotations` 增加 scope 状态）、`src/components/reader/TutorPanel.tsx`（历史列表头部加「本章 / 本课程」tab）

- `useTutor` 增加 `historyScope: "chapter" | "course"` 状态，`reloadAnnotations` 按 scope 拼参数。
- **跨章打开线程**：历史列表点击其他章节的线程时，先 `router.push('/courses/{id}/chapters/{annotation.chapterId}')` 再 `openThread`（页面已用 `useRouter`，模式现成）。原因：锚定引用跳转依赖当前 DOM 中的 `data-section-id`，跨章线程必须落在其所属章节才能点跳。

### P2-3 标题/摘要自动生成（确定性，零 LLM 开销）

**改动**：`src/app/api/annotations/route.ts` 成功保存前（流式 :190-205 与非流式 :94-109 两处共用一个小工具函数）

```ts
function withDerivedTitleSummary(annotation: Annotation): Annotation {
  return {
    ...annotation,
    title: annotation.title?.trim() || truncate(annotation.question, 30),
    summary: annotation.summary?.trim()
      || truncate(firstParagraph(lastAssistantMessage(annotation)), 80),
  };
}
```

写入时机 = `saveServerAnnotation` 前，一处生效；`title`/`summary` 字段已存在于 `Annotation` 类型（types.ts:333-335）与 payload（jsonb）持久化，**零 schema 改动**。UI 侧 `TutorPanel.tsx:122-124` 已读这两个字段，无需改动。

验收：历史列表不再显示整段长问题原文；泛问线程显示截断标题 + 首段摘要。

### P2-4 切章重置状态

**改动**：`src/lib/hooks/useTutor.ts`

```ts
useEffect(() => {
  controllerRef.current?.abort(); // 关键：中止进行中的流，防止旧章 token 继续冒字
  setActive(undefined);
  setTarget(undefined);
  setError("");
}, [chapterId]);
```

验收：切章瞬间旧对话消失；切章前进行中的流被中止，新章面板不再收到旧 token。

---

## 5. Phase 3 — Grounding + 行内引用（差异化核心）

### P3-1 prompt：节号索引 + 引用语法 + 反幻觉规则

**改动**：`src/lib/prompts/textbookSkill.ts`（`tutorSkill`）、`src/lib/prompts/annotationTutor.ts`

1. **章节地图复用**：P0-2 的「章节地图」同时是引用节号索引——模型只能引用地图里出现的节号，杜绝幻觉节号。
2. **引用语法约定**（写入 `tutorSkill`）：
   - 引用教材内容时输出 `[§n]`（n 为章节地图中的整数节号，紧跟被引用的陈述之后）。
   - 禁止在代码块、公式内使用引用标记。
   - 一个回答中引用同一节多次可重复 `[§n]`。
3. **反幻觉规则**（写入 `tutorSkill`，这是与现行规则的行为变化——现行 prompt:82 行主动鼓励超纲补充）：
   - 只依据注入的正文回答；正文没有的内容不编造。
   - 正文未覆盖但学生需要 → 先明确说「教材正文未覆盖」，再补充，且补充部分以「（教材外补充）」标注，**不带引用标记**。

### P3-2 引用数据模型

**改动**：`src/lib/types.ts`

```ts
export type Citation = {
  sectionId: string;
  label: string; // "§3"，用于 chip 显示
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[]; // 仅 assistant 消息
};
```

**设计取舍**：v1 不做 `quote` 字段（模型输出逐字引文极易幻觉，逐字校验成本高）。悬停预览的「原文片段」改为**客户端从已加载 section.content 取首段**——数据本地、零延迟、零幻觉，正是规避 AlphaXiv 慢 tooltip 的方案。

持久化：citations 随 `annotations.payload`（jsonb）落库，`annotation_messages` 表结构不动（其 role/content 列继续正常写）。`compactTutorHistory` 只取 role/content，模型上下文自动剔除 citations，无需处理。

### P3-3 服务端解析、校验、清洗

**改动**：新增 `src/lib/citations.ts` + `src/app/api/annotations/route.ts` 保存前调用

```ts
export function parseCitations(
  text: string,
  sectionIndex: Map<string, string>, // label("§3") -> sectionId
): { cleanText: string; citations: Citation[] }
```

- 正则 `\[§(\d+)\]`，按出现顺序去重。
- `label` 不在索引表 → **丢弃标记且不改文本**（宁可不渲染，不给假引用）。
- 返回 `cleanText`（标记已移除）+ `citations`，**服务端存 cleaned content**，落库内容干净。
- 流式路径在 `fullAnswer` 累积完成后解析（route :170-172 之后）；非流式同理。
- 引用解析失败不影响回答保存（解析是增强，不是门槛）。

### P3-4 前端渲染 + 跳转 + 悬停

**改动**：`src/components/MarkdownContent.tsx`（通用，tutor 与正文共用组件，注意改动不回退正文渲染）、`src/components/reader/TutorPanel.tsx`、`src/app/courses/[id]/chapters/[chapterId]/page.tsx`

1. **渲染**：`MarkdownContent` 增加可选 prop `citations?: Record<string, Citation>`（按 `[§n]` 文本匹配）。渲染前把 `[§n]` 预处理为 `[§n](cite://n)` 链接，扩展 `a` 组件：`href` 以 `cite://` 开头 → 渲染 `<CitationChip>`；否则走现有外链逻辑。
2. **流式期**：tokens 到达时 raw `[§2]` 会短暂可见。客户端用本地 `chapter.sections`（按 order 映射 §n→sectionId）**实时**把已闭合的 `[§n]` 渲染为 chip；`done` 事件后以 saved annotation 的 citations 为准（与服务端校验结果一致）。
3. **点击跳转**：`scrollIntoView` 到 `#section-{sectionId}`（锚点已存在，page.tsx:692），跳转前记录回答区滚动位置。
4. **悬停**：chip 悬停显示节标题 + 该节 content 首段摘录（本地 section 数据，秒出）。
5. **返回**：TutorPanel 消息区顶部出现「返回回答」按钮，恢复跳转前的滚动位置。

验收：回答中出现可点 chip；悬停秒出标题+原文片段；点击正文滚动到对应节；「返回」回到回答原位置；无效节号的标记原样显示为普通文本（服务端已丢弃）。

### P3-5 （随 P3-4 一并交付）chip 在历史线程中的回显

历史线程打开时 citations 从 payload 随消息带回，渲染逻辑与流式后一致，无需额外工作（仅测试覆盖）。

---

## 6. Phase 4 — 体验打磨

### P4-1 上下文感知建议问题

- 选中文本时：基于 `selectedText` + 节标题动态生成 3 条（可先做确定性模板：`解释这段里的 X` 需 LLM → 改为**懒生成**：仅当用户停留在 chooser >1s 或点击「更多建议」才调一次轻量 LLM；默认展示 3 条本地模板，避免每次选中都烧调用）。
- 泛问入口：基于章节地图的节标题模板化生成，零 LLM。
- 替换 `TutorPanel.tsx:8` 写死的 `quickQuestions`。

### P4-2 历史截断透明化

`compactTutorHistory`（client.ts:1253-1261）截断到 8 条时，在 prompt 的「此前讨论」前加一行 `（早期对话已省略，仅保留最近 8 条）`。

### P4-3 术语表按需注入

- 现为全量注入（annotationTutor.ts:47-49）。改为**关键词重叠匹配**：问题 + selectedText 的 term 命中术语表 term → 只注入命中项 + 其定义；无命中则不注入。
- 与 P0-2 的 token 预算联动：正文注入优先，术语表命中项封顶 8 条。

### P4-4 流式错误处理收尾

P1-1 已覆盖终结事件与断流；本项只做审查确认：`stop`（用户中止）/ 超时 / 断流 / 服务端 error 四种路径均落到明确 UI 状态，`createSseParser` 本身不改（其 error 会从 `feed` 同步抛出，链路已通）。

---

## 7. 测试策略

| 层 | 内容 |
|---|---|
| 单元 | 新增 `tests/unit/citations.test.ts`：解析/去重/无效节号丢弃/清洗文本；扩展 `tests/unit/prompt-architecture.test.ts`：prompt 含章节地图、`chapterSummary` 不再含 `summaryForNext`、引用语法与反幻觉规则存在 |
| 单元 | `withDerivedTitleSummary`、`listServerAnnotations` 双过滤（本地 fallback 路径可测） |
| E2E | 现有 tutor 流程回归（提问/流式/历史/删除）。**引用 chip 与续写在 mock 模式不可见**（已拍板不做 mock 适配），由真实 AI smoke（`AI_SMOKE=true npm run test:ai-smoke` 扩展 tutor 场景）与手动验收覆盖 |
| 手动验收 | 见各 Phase 验收条目 + 长推导续写 + 断流（DevTools 断网）场景 |

约束：`npm run build` 与 `test:e2e` 串行（共用 `.next`）；Phase 3 的 `MarkdownContent` 改动需跑现有正文渲染 E2E 防回退。

## 8. 落地顺序

```
P0-1 → P0-2 → P0-3        （同 Phase 0，可一个 PR 或三个小 PR）
P1-1 → P1-2                （失败可见，量小）
P2-4 → P2-1 → P2-2 → P2-3  （历史全局化；P2-4 一行级先做）
P3-1 → P3-2 → P3-3 → P3-4  （Grounding，单独迭代立项）
P4-1 → P4-2 → P4-3 → P4-4
```

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 续写导致超时/成本上升 | 段数上限 2；三层超时重配；quota 每次提问仍只计一次 |
| 注入正文撑爆上下文 | 分层注入 + 硬上限 + 术语表让位正文；锚定优先节全文、泛问只给节地图 |
| 模型幻觉节号 | 只允许引用「章节地图」中的节号 + 服务端校验丢弃；无效引用不落库 |
| 历史 payload 体积 | 消息已 1200 字截断进上下文；citations 只存 sectionId+label，极小 |
| 存量行 `course_id` 为 null | course 级查询查不到旧行，可选一次性回填迁移 |
| 跨章打开线程引用跳转失效 | 跨章线程先导航到所属章节再打开（P2-2） |
| `MarkdownContent` 改动影响正文渲染 | 引用预处理只对 tutor 消息启用（prop 开关），正文路径默认关闭 |

## 10. 文件改动地图

| 文件 | 阶段 |
|---|---|
| `src/lib/hooks/useTutor.ts` | P0-1、P1-1、P2-2、P2-4 |
| `src/app/api/annotations/route.ts` | P0-2、P1-2、P2-1、P2-3、P3-3 |
| `src/lib/prompts/annotationTutor.ts` | P0-2、P3-1、P4-2、P4-3 |
| `src/lib/prompts/textbookSkill.ts` | P3-1 |
| `src/lib/maol/client.ts` | P0-3、P4-2 |
| `src/lib/serverStore.ts` | P2-1 |
| `src/lib/types.ts` | P3-2 |
| `src/lib/citations.ts`（新增） | P3-3 |
| `src/components/MarkdownContent.tsx` | P3-4 |
| `src/components/reader/TutorPanel.tsx` | P2-2、P3-4、P4-1 |
| `src/app/courses/[id]/chapters/[chapterId]/page.tsx` | P3-4（跳转/返回） |
| `tests/unit/citations.test.ts`（新增） | 测试 |
| `tests/unit/prompt-architecture.test.ts` | 测试 |

## 11. Backlog（本计划外）

- 段落级引用（需为正文段落建锚点基建）
- 会话地图/导航条（对应 AlphaXiv issue #344 minimap）
- 「对上一轮回答二次选中提问」
- 彻底移除 mock 模式（涉及 `test:phase-gate` 与开发流程，独立立项）
