import type {
  Chapter,
  CompanionBlock,
  CompanionGuide,
  CompanionQuizQuestion,
  CompanionSelfCheck,
  Course,
} from "@/lib/types";

/**
 * Companion guide (AI 伴学指南) prompts. The guide is a condensed 15-20
 * minute interactive self-study layer over one existing chapter — no
 * re-planning, no new course. It works for BOTH content modes: a textbook
 * chapter (教材原文) or a lecture-mode chapter (讲义原文) is condensed into
 * objectives → review → teach blocks → recap → preview, plus inline
 * self-checks and a final quiz. Hard rule: it must not introduce any
 * concept, formula, example, or data point the chapter does not contain,
 * and it never becomes part of the chapter body or its PDF/TeX export.
 */

const MAX_OBJECTIVES = 4;
const MIN_TEACH_BLOCKS = 2;
const MAX_TEACH_BLOCKS = 10;
const MIN_SELF_CHECK = 2;
const MAX_SELF_CHECK = 4;
const MIN_QUIZ = 3;
const MAX_QUIZ = 5;
const MIN_QUIZ_OPTIONS = 3;
const MAX_QUIZ_OPTIONS = 5;
const MAX_ANCHOR_LENGTH = 120;

/**
 * Real Markdown headings of the chapter body — the only legal anchor
 * targets. Numbered "## N.M 标题" headings yield their number; any other
 * "## 标题" heading yields its title text, so the guide never depends on
 * the textbook's fixed N.M numbering.
 */
export function extractChapterSectionAnchors(content: string): { label: string; anchor: string }[] {
  const seen = new Set<string>();
  const anchors: { label: string; anchor: string }[] = [];
  const matches = content.matchAll(/^##\s+(.+)$/gmu);
  for (const match of matches) {
    const heading = (match[1] ?? "").trim();
    if (!heading || seen.has(heading)) continue;
    seen.add(heading);
    const numbered = heading.match(/^(\d+(?:\.\d+)*)[\s、.．-]/u);
    anchors.push({ label: heading, anchor: numbered?.[1] ?? heading });
  }
  return anchors;
}

export function buildCompanionGuidePrompt(
  course: Course,
  chapter: Chapter,
  content: string,
  chapterIndex: number,
) {
  const anchors = extractChapterSectionAnchors(content);
  const sourceName = course.contentMode === "textbook" ? "教材" : "讲义";
  const sourceLabel = course.contentMode === "textbook" ? "教材原文" : "讲义原文";
  const contract = chapter.contract ?? course.courseBible.chapterContracts?.find((item) => item.chapterTitle === chapter.title);
  const terminology = (course.courseBible.terminology ?? [])
    .map((item) => `- ${item.term}：${item.definition}（首次出现于：${item.introducedIn}）`)
    .join("\n");
  const notation = (course.courseBible.notation ?? [])
    .map((item) => `- ${item.symbol}：${item.meaning}`)
    .join("\n");
  const nextChapter = chapterIndex >= 0 ? course.chapters[chapterIndex + 1] : undefined;

  return `你是一名中文伴学引导师。你的任务是把${sourceName}的一个章节浓缩成一份 15~20 分钟的伴学指南：学习者不需要老师，跟着指南就能把这一章学进去。伴学指南是叠加在原文之上的交互学习层，它本身不会进入${sourceName}正文，也不会进入任何 PDF/TeX 出版物。

# 输入

书名 / 主题：${course.topic}
章节：第 ${chapterIndex + 1} 章《${chapter.title}》（全书共 ${course.chapters.length} 章）
上一章承接：${chapter.connectionFromPrevious ?? "这是课程起点。"}
下一章预告来源：${nextChapter ? `《${nextChapter.title}》——${nextChapter.description}` : "这是最后一章。"}
本章契约：
${JSON.stringify(contract ?? {}, null, 2)}

Course Bible 术语表（伴学指南必须逐字沿用，不得换词）：
${terminology || "（空）"}

Course Bible 记号表（伴学指南必须逐字沿用同一套符号）：
${notation || "（空）"}

章节正文（伴学指南的唯一素材来源，即${sourceLabel}）：
<chapter_content>
${content}
</chapter_content>

# 硬性规则（违反任何一条即不合格）

1. 伴学指南只允许使用上面章节正文里出现过的概念、公式、例子、数据、结论；禁止引入正文和契约之外的任何新概念、新公式、新例子、新数据或"最新进展"。
2. 术语与记号逐字沿用 Course Bible 术语表 / 记号表，禁止另起译名或换符号。
3. 讲解口吻是"讲课"而不是"写书"：口语、直给、有引导（允许"注意了""这里有个常见的坑"），但概念表述必须准确。
4. 总量控制在 15~20 分钟阅读量：所有 teach 块的 intuition + concept + example 合计约 3000~4500 个汉字；不要为凑字数重复正文。
5. teach 块按章节正文的小节组织（3~10 个），每个块对应一章正文里的一个小节；anchorSection 必须从下面这份"本章真实标题/编号"里选（若无可用标题就省略该字段）：
${anchors.length ? anchors.map((a) => `- ${a.label}（anchorSection: ${a.anchor}）`).join("\n") : "（本章正文没有 ## 标题）"}
6. 每个 teach 块必须包含：直觉切入（先讲"为什么"）、核心概念（准确、可复述）、1 个最小例子（正文中出现过的例子，简化但不失真）。
7. 随堂自测 ${MIN_SELF_CHECK}~${MAX_SELF_CHECK} 道概念理解题，每题附 2~4 句的简短解释；小测 ${MIN_QUIZ}~${MAX_QUIZ} 道单选题，每题 ${MIN_QUIZ_OPTIONS}~${MAX_QUIZ_OPTIONS} 个选项、只有 1 个正确答案，并附一句解释。
8. 不写练习题的完整长解答（那是${sourceName}正文的事）；所有题都服务于"检验这一章有没有听懂"。
9. 公式必须带定界符：行内公式用 $...$，独立公式用 $$...$$；禁止输出不带 $ 的裸 LaTeX（例如 G_t = R_{t+1} + \\gamma G_{t+1} 必须写成 $G_t = R_{t+1} + \\gamma G_{t+1}$）。下标、希腊字母一律用 LaTeX 命令（_ 与 ^ 也要用）。
10. 只输出合法 JSON，不要输出 Markdown、代码围栏或解释文字；第一个字符必须是 {，最后一个字符必须是 }。

# 输出结构

{
  "learningObjectives": ["读完本讲你将能……", "……", "……"],
  "blocks": [
    { "kind": "review", "text": "用 2~3 句话回顾上一讲与本讲的衔接，直接点名上一章的结论" },
    { "kind": "teach", "title": "本块主题（小节标题）", "intuition": "直觉切入", "concept": "核心概念讲解", "example": "最小例子", "anchorSection": "3.2" },
    { "kind": "recap", "points": ["本讲记住的第一件事", "第二件事", "第三件事"] },
    { "kind": "preview", "text": "1 句话预告下一讲" }
  ],
  "selfCheck": [
    { "question": "随堂自测题", "answer": "简短解释" }
  ],
  "finalQuiz": [
    { "question": "单选题题干", "options": ["选项A", "选项B", "选项C", "选项D"], "correctIndex": 0, "explanation": "为什么选它、为什么其他不对" }
  ]
}

结构要求：
- learningObjectives 写 2~${MAX_OBJECTIVES} 条，措辞是"读完本讲你能……"的能力描述。
- blocks 顺序固定：1 个 review 开头 → 3~${MAX_TEACH_BLOCKS} 个 teach → 1 个 recap → 1 个 preview 结尾。
- recap.points 必须恰好 3 条。
- finalQuiz 每题 options ${MIN_QUIZ_OPTIONS}~${MAX_QUIZ_OPTIONS} 个，correctIndex 是 0 起始的正确项下标。
- 所有字符串用中文标点；JSON 字符串内部不要直接换行。`;
}
function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item)).filter((item): item is string => Boolean(item));
}

function parseTeachBlock(raw: Record<string, unknown>): Extract<CompanionBlock, { kind: "teach" }> | undefined {
  const title = cleanText(raw.title);
  const intuition = cleanText(raw.intuition);
  const concept = cleanText(raw.concept);
  const example = cleanText(raw.example);
  if (!title || !intuition || !concept || !example) return undefined;
  const anchorSection = cleanText(raw.anchorSection);
  return anchorSection && anchorSection.length <= MAX_ANCHOR_LENGTH
    ? { kind: "teach", title, intuition, concept, example, anchorSection }
    : { kind: "teach", title, intuition, concept, example };
}

function parseBlocks(value: unknown): CompanionBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: CompanionBlock[] = [];
  let sawReview = false;
  let sawRecap = false;
  let sawPreview = false;

  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (raw.kind === "review") {
      if (sawReview) continue;
      const text = cleanText(raw.text);
      if (text) {
        blocks.push({ kind: "review", text });
        sawReview = true;
      }
    } else if (raw.kind === "teach") {
      const block = parseTeachBlock(raw);
      if (block) blocks.push(block);
    } else if (raw.kind === "recap") {
      if (sawRecap) continue;
      const points = cleanTextList(raw.points);
      if (points.length > 0) {
        blocks.push({ kind: "recap", points: points.slice(0, 3) });
        sawRecap = true;
      }
    } else if (raw.kind === "preview") {
      if (sawPreview) continue;
      const text = cleanText(raw.text);
      if (text) {
        blocks.push({ kind: "preview", text });
        sawPreview = true;
      }
    }
  }
  return blocks;
}

function parseSelfCheck(value: unknown): CompanionSelfCheck[] {
  if (!Array.isArray(value)) return [];
  const items = value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as Record<string, unknown>;
    const question = cleanText(raw.question);
    const answer = cleanText(raw.answer);
    return question && answer ? [{ question, answer }] : [];
  });
  return items.slice(0, MAX_SELF_CHECK);
}

function parseFinalQuiz(value: unknown): CompanionQuizQuestion[] {
  if (!Array.isArray(value)) return [];
  const items = value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as Record<string, unknown>;
    const question = cleanText(raw.question);
    const options = cleanTextList(raw.options);
    const correctIndex = typeof raw.correctIndex === "number" ? Math.trunc(raw.correctIndex) : NaN;
    const explanation = cleanText(raw.explanation);
    if (
      !question
      || options.length < MIN_QUIZ_OPTIONS
      || options.length > MAX_QUIZ_OPTIONS
      || !Number.isInteger(correctIndex)
      || correctIndex < 0
      || correctIndex >= options.length
      || !explanation
    ) {
      return [];
    }
    return [{ question, options, correctIndex, explanation }];
  });
  return items.slice(0, MAX_QUIZ);
}

/**
 * Parse + validate a companion-guide JSON payload. Throws with a concrete
 * reason on structural violations so the caller can retry with the failure
 * message.
 */
export function parseCompanionGuide(raw: string): CompanionGuide {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("伴学指南输出不是合法 JSON。");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("伴学指南输出不是 JSON 对象。");
  }
  const record = payload as Record<string, unknown>;

  const learningObjectives = cleanTextList(record.learningObjectives).slice(0, MAX_OBJECTIVES);
  if (learningObjectives.length < 2) {
    throw new Error(`learningObjectives 少于 2 条（实际 ${learningObjectives.length} 条）。`);
  }

  const blocks = parseBlocks(record.blocks);
  const teachBlocks = blocks.filter((block) => block.kind === "teach");
  if (!blocks.some((block) => block.kind === "review")) {
    throw new Error("blocks 缺少 review 开场块。");
  }
  if (teachBlocks.length < MIN_TEACH_BLOCKS || teachBlocks.length > MAX_TEACH_BLOCKS) {
    throw new Error(`teach 块数量必须在 ${MIN_TEACH_BLOCKS}~${MAX_TEACH_BLOCKS} 之间（实际 ${teachBlocks.length} 个）。`);
  }
  if (!blocks.some((block) => block.kind === "recap")) {
    throw new Error("blocks 缺少 recap 复盘块。");
  }

  const selfCheck = parseSelfCheck(record.selfCheck);
  if (selfCheck.length < MIN_SELF_CHECK) {
    throw new Error(`selfCheck 少于 ${MIN_SELF_CHECK} 道（实际 ${selfCheck.length} 道）。`);
  }

  const finalQuiz = parseFinalQuiz(record.finalQuiz);
  if (finalQuiz.length < MIN_QUIZ) {
    throw new Error(`finalQuiz 少于 ${MIN_QUIZ} 道合格单选题（实际 ${finalQuiz.length} 道）。`);
  }

  return {
    status: "ready",
    learningObjectives,
    blocks,
    selfCheck,
    finalQuiz,
    generatedAt: new Date().toISOString(),
  };
}

/** Deterministic mock-mode companion guide used when AI_MOCK_MODE is active. */
export function buildMockCompanionGuide(chapter: Chapter, chapterIndex: number): CompanionGuide {
  const number = chapterIndex + 1;
  const title = chapter.title;
  return {
    status: "ready",
    learningObjectives: [
      `读完本讲，你能用自己的话说清《${title}》的核心思路。`,
      `你能独立完成本章的 1 个最小例子。`,
      "你能通过随堂自测和小测检验本讲理解程度。",
    ],
    blocks: [
      { kind: "review", text: "上一讲我们已经搭好了必要的基础；本讲在此之上展开，讲透一个核心主题。" },
      {
        kind: "teach",
        title: `${title}的核心直觉`,
        intuition: `先建立直觉：本章要解决的实际问题是什么，为什么它值得专门用一节来讲。`,
        concept: `核心概念：围绕《${title}》的主线方法，给出准确的定义与适用边界，并说明它与已学内容的关系。`,
        example: "最小例子：用一个走一遍就能懂的小例子演示主流程，每一步说明为什么这么做。",
        anchorSection: `${number}.1`,
      },
      {
        kind: "teach",
        title: "关键步骤与常见误区",
        intuition: "讲完直觉后，我们把关键步骤拆开看：每一步在做什么、为什么不能跳过。",
        concept: "关键结论：逐步说明推导或操作流程，交代每一步的动机与前提。",
        example: "换一个稍有不同的情形再走一遍，指出常见误区与失败模式。",
        anchorSection: `${number}.2`,
      },
      {
        kind: "teach",
        title: "回到主线",
        intuition: "把本讲的结论放回全书主线：它解决了什么问题，还留下什么待下一讲解决。",
        concept: "收束：把零散的要点串成一条可复述的逻辑链。",
        example: "用一句话复述本讲方法适用于什么场景、不适用于什么场景。",
      },
      { kind: "recap", points: ["记住核心概念的定义与动机。", "记住关键步骤的顺序与每一步的作用。", "记住适用边界与常见误区。"] },
      { kind: "preview", text: "下一讲将在此基础上引入新的工具，解决本章留下的边界问题。" },
    ],
    selfCheck: [
      { question: "用自己的话说说本讲的核心概念解决什么问题？", answer: "能把动机讲清、并能指出它相对朴素做法的改进，即视为理解。" },
      { question: "本讲的最小例子里，哪一步最关键？", answer: "关键步骤是概念落地的枢纽；答出它并能解释原因即可。" },
      { question: "本讲方法在什么情形下会失效？", answer: "能说出至少一个适用边界或常见误区即为通过。" },
    ],
    finalQuiz: [
      {
        question: `《${title}》的核心概念主要解决什么问题？`,
        options: ["装饰性的概念辨析", "本讲主线方法对应的实际问题", "与本章无关的旁支话题", "后续章节才展开的内容"],
        correctIndex: 1,
        explanation: "伴学指南围绕章节主线组织，核心概念服务于主线问题；其余选项偏离本讲目标。",
      },
      {
        question: "随堂自测的作用是什么？",
        options: ["替代原文练习", "检验本讲有没有听懂", "凑满篇幅", "生成更多题目"],
        correctIndex: 1,
        explanation: "自测用于即时检验理解，原文的完整练习与解答仍以原文为准。",
      },
      {
        question: "伴学指南里出现的内容应当来自哪里？",
        options: ["该章正文与契约", "引导师的新增发挥", "其他书籍的引用", "任意联想"],
        correctIndex: 0,
        explanation: "伴学指南是章节的浓缩，不得引入章节之外的新概念、公式或例子。",
      },
      {
        question: "本讲结束后下一步学什么？",
        options: ["重新学一遍本讲", "按 preview 预告进入下一讲", "跳过剩余章节", "直接导出整本书"],
        correctIndex: 1,
        explanation: "preview 块预告了下一讲内容，按顺序继续即可。",
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/** @deprecated Renamed to buildCompanionGuidePrompt; kept for one release cycle. */
export const buildLecturePrompt = buildCompanionGuidePrompt;
/** @deprecated Renamed to parseCompanionGuide; kept for one release cycle. */
export const parseLecture = parseCompanionGuide;
/** @deprecated Renamed to buildMockCompanionGuide; kept for one release cycle. */
export const buildMockLecture = buildMockCompanionGuide;
/** @deprecated Renamed to extractChapterSectionAnchors; returns anchor values only. */
export function extractChapterSectionNumbers(content: string): string[] {
  return extractChapterSectionAnchors(content).map((item) => item.anchor);
}

