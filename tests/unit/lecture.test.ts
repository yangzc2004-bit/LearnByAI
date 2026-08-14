import assert from "node:assert/strict";
import test from "node:test";
import { readQuotaLimit } from "../../src/lib/quotaConfig";
import { buildLecturePrompt, buildMockLecture, extractChapterSectionNumbers, parseLecture } from "../../src/lib/prompts/lecture";
import type { Chapter, Course } from "../../src/lib/types";

const course = {
  id: "c",
  topic: "强化学习",
  goal: "掌握核心算法",
  background: "",
  styles: [],
  learningMode: "standard",
  chapterCount: 8,
  difficulty: "intermediate",
  profile: "",
  contentMode: "textbook",
  courseBible: {
    targetLearner: "",
    finalOutcomes: [],
    teachingStyle: "",
    prerequisites: [],
    globalNarrative: "",
    terminology: [{ term: "马尔可夫决策过程", definition: "五元组模型", introducedIn: "第 2 章" }],
    notation: [{ symbol: "$v_\\pi(s)$", meaning: "状态价值" }],
    chapterDependencies: [],
  },
  chapters: [{ id: "ch", title: "动态规划", description: "", time: { readingMinutes: 10, exerciseMinutes: 10, practiceMinutes: 10, extensionMinutes: 10 } }],
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Course;

const chapter = course.chapters[0] as unknown as Chapter;

const CHAPTER_CONTENT = [
  "# 3 动态规划",
  "## 3.1 策略评估",
  "给定策略求价值函数。",
  "## 3.2 策略迭代",
  "评估与改进交替进行。",
].join("\n");

test("buildLecturePrompt anchors the lecture to the chapter content and bible rules", () => {
  const prompt = buildLecturePrompt(course, chapter, CHAPTER_CONTENT, 2);
  assert.ok(prompt.includes("动态规划"), prompt);
  assert.ok(prompt.includes("策略评估"), prompt);
  assert.ok(prompt.includes("马尔可夫决策过程"), prompt);
  assert.ok(prompt.includes("$v_\\pi(s)$"), prompt);
  assert.ok(prompt.includes("3.1"), prompt);
  assert.ok(prompt.includes("3.2"), prompt);
  // Hard rules must be present verbatim.
  assert.ok(prompt.includes("禁止引入正文和契约之外的任何新概念"), prompt);
  assert.ok(prompt.includes("逐字沿用 Course Bible 术语表"), prompt);
  assert.ok(prompt.includes("15~20 分钟阅读量"), prompt);
  assert.ok(prompt.includes("anchorSection"), prompt);
  // Formulas must carry $ delimiters from the source (plus the render-side
  // bare-LaTeX healing as a second line of defense).
  assert.ok(prompt.includes("公式必须带定界符"), prompt);
  assert.ok(prompt.includes("禁止输出不带 $ 的裸 LaTeX"), prompt);
});

test("extractChapterSectionNumbers collects numbered and unnumbered headings", () => {
  const numbers = extractChapterSectionNumbers([
    "# 3 动态规划",
    "## 3.1 策略评估",
    "## 3.2 策略迭代",
    "## 3.2.1 细节",
    "正文里的 3.3 不是标题",
    "## 练习",
    "## 问题导入",
  ].join("\n"));
  assert.deepEqual(numbers, ["3.1", "3.2", "3.2.1", "练习", "问题导入"]);
  assert.deepEqual(extractChapterSectionNumbers("没有 ## 标题"), []);
});

test("parseLecture accepts a well-formed lecture payload", () => {
  const lecture = parseLecture(JSON.stringify(buildMockLecture(chapter, 2)));
  assert.equal(lecture.status, "ready");
  assert.equal(lecture.learningObjectives!.length, 3);
  assert.ok(lecture.blocks!.some((block) => block.kind === "review"));
  assert.equal(lecture.blocks!.filter((block) => block.kind === "teach").length, 3);
  assert.ok(lecture.blocks!.some((block) => block.kind === "recap"));
  assert.ok(lecture.blocks!.some((block) => block.kind === "preview"));
  assert.equal(lecture.selfCheck!.length, 3);
  assert.equal(lecture.finalQuiz!.length, 4);
  assert.ok(lecture.generatedAt);
});

test("parseLecture rejects structural violations with concrete reasons", () => {
  assert.throws(() => parseLecture("not json"), /合法 JSON/);
  assert.throws(() => parseLecture("[]"), /JSON 对象/);

  const noObjectives = { ...buildMockLecture(chapter, 2), learningObjectives: ["只有一条"] };
  assert.throws(() => parseLecture(JSON.stringify(noObjectives)), /learningObjectives/);

  const noReview = buildMockLecture(chapter, 2);
  noReview.blocks = noReview.blocks!.filter((block) => block.kind !== "review");
  assert.throws(() => parseLecture(JSON.stringify(noReview)), /review/);

  const emptyRecap = buildMockLecture(chapter, 2);
  emptyRecap.blocks = emptyRecap.blocks!.map((block) => (
    block.kind === "recap" ? { ...block, points: [] } : block
  ));
  assert.throws(() => parseLecture(JSON.stringify(emptyRecap)), /recap/);

  const badQuiz = buildMockLecture(chapter, 2);
  badQuiz.finalQuiz = badQuiz.finalQuiz!.map((question, index) => (
    index < 2 ? { ...question, correctIndex: 99 } : question
  ));
  assert.throws(() => parseLecture(JSON.stringify(badQuiz)), /finalQuiz 少于/);
});

test("parseLecture normalizes junk entries and drops bad quiz options", () => {
  const payload = JSON.stringify({
    learningObjectives: ["目标一", "目标二", "", 42, "目标三"],
    blocks: [
      { kind: "review", text: " 回顾 " },
      { kind: "teach", title: " 块一 ", intuition: "直觉", concept: "概念", example: "例子", anchorSection: "3.1" },
      { kind: "teach", title: "块二", intuition: "直觉", concept: "概念", example: "例子", anchorSection: "不是编号" },
      { kind: "teach", title: "块三", intuition: "直觉", concept: "概念", example: "例子" },
      { kind: "unknown", text: "丢弃" },
      { kind: "recap", points: ["一", "二", "三", "多余", ""] },
      { kind: "preview", text: "下讲预告" },
    ],
    selfCheck: [
      { question: "题一", answer: "答一" },
      { question: "", answer: "缺题" },
      { question: "题二", answer: "答二" },
      { question: "题三", answer: "答三" },
      { question: "题四", answer: "答四" },
      { question: "题五", answer: "超出上限" },
    ],
    finalQuiz: [
      { question: "q1", options: ["a", "b"], correctIndex: 0, explanation: "选项不足" },
      { question: "q2", options: ["a", "b", "c", "d"], correctIndex: 3, explanation: "x" },
      { question: "q3", options: ["a", "b", "c"], correctIndex: 0, explanation: "y" },
      { question: "q4", options: ["a", "b", "c", "d"], correctIndex: 1, explanation: "z" },
    ],
  });

  const lecture = parseLecture(payload);
  assert.deepEqual(lecture.learningObjectives, ["目标一", "目标二", "目标三"]);
  const teachBlocks = lecture.blocks!.filter((block) => block.kind === "teach");
  assert.equal(teachBlocks.length, 3);
  const first = teachBlocks[0] as Extract<(typeof teachBlocks)[number], { kind: "teach" }>;
  assert.equal(first.anchorSection, "3.1");
  const second = teachBlocks[1] as Extract<(typeof teachBlocks)[number], { kind: "teach" }>;
  assert.equal(second.anchorSection, "不是编号");
  const recap = lecture.blocks!.find((block) => block.kind === "recap") as { points: string[] };
  assert.deepEqual(recap.points, ["一", "二", "三"]);
  assert.equal(lecture.selfCheck!.length, 4);
  assert.equal(lecture.finalQuiz!.length, 3);
});

test("generate_lecture quota has its own default and env override", () => {
  assert.equal(readQuotaLimit("generate_lecture"), 100);
  const snapshot = process.env.QUOTA_GENERATE_LECTURE;
  try {
    process.env.QUOTA_GENERATE_LECTURE = "7";
    assert.equal(readQuotaLimit("generate_lecture"), 7);
  } finally {
    if (snapshot === undefined) delete process.env.QUOTA_GENERATE_LECTURE;
    else process.env.QUOTA_GENERATE_LECTURE = snapshot;
  }
});
