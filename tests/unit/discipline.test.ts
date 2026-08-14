import assert from "node:assert/strict";
import test from "node:test";
import { countFencedCodeBlocks, validateDisciplineMix } from "../../src/lib/quality/discipline";
import { Chapter, Course } from "../../src/lib/types";

function algorithmCourse(): Course {
  return {
    id: "course-1",
    topic: "强化学习",
    goal: "掌握核心算法",
    background: "",
    styles: [],
    learningMode: "guided",
    chapterCount: 5,
    difficulty: "intermediate",
    discipline: "algorithm-engineering",
    profile: "路线",
    courseBible: {
      targetLearner: "研究生",
      finalOutcomes: ["能实现表格型 DP"],
      teachingStyle: "严谨",
      prerequisites: [],
      globalNarrative: "递进",
      terminology: [],
      chapterDependencies: [],
    },
    chapters: [],
    createdAt: new Date().toISOString(),
  };
}

function chapter(title: string, contract?: Chapter["contract"]): Chapter {
  return {
    id: "ch-1",
    title,
    description: "概述",
    purpose: "任务",
    connectionFromPrevious: "承接",
    setupForNext: "铺垫",
    time: { readingMinutes: 60, exerciseMinutes: 30, practiceMinutes: 30, extensionMinutes: 15 },
    depthWeight: "normal",
    contract,
    status: "ready",
  };
}

test("countFencedCodeBlocks counts executable vs pseudocode languages", () => {
  const content = [
    "```python",
    "def dp(): return 0",
    "```",
    "```pseudocode",
    "初始化 V(s)",
    "```",
    "```text",
    "纯文本示意",
    "```",
  ].join("\n");
  assert.deepEqual(countFencedCodeBlocks(content), { executable: 1, pseudocode: 1 });
});

test("validateDisciplineMix errors when an algorithm chapter promises code but ships none", () => {
  const course = algorithmCourse();
  const issues = validateDisciplineMix(
    chapter("动态规划", {
      chapterTitle: "动态规划",
      requiredTopics: ["策略迭代的收敛性"],
      bridgeFromPrevious: "承接",
      bridgeToNext: "铺垫",
      forbiddenEarlyTopics: [],
      requiredExamples: ["实现表格型策略迭代算法"],
      requiredFormulas: [],
    }),
    "正文只讲原理，没有任何代码块。",
    course,
  );
  const codeIssue = issues.find((issue) => issue.check === "discipline.code_mix");
  assert.ok(codeIssue, JSON.stringify(issues));
  assert.equal(codeIssue!.severity, "error");
});

test("validateDisciplineMix passes when runnable code and a figure are present", () => {
  const course = algorithmCourse();
  const issues = validateDisciplineMix(
    chapter("动态规划", {
      chapterTitle: "动态规划",
      requiredTopics: ["策略迭代"],
      bridgeFromPrevious: "承接",
      bridgeToNext: "铺垫",
      forbiddenEarlyTopics: [],
      requiredExamples: ["实现策略迭代"],
      requiredFormulas: [],
    }),
    [
      "讲解。",
      "```python",
      "def policy_iteration():",
      "    return 0",
      "```",
      "逐行解释与预期输出。",
      ":::learnbyai-figure",
      "caption: 策略迭代流程",
      "prompt: 画流程图",
      "diagramSpec: 评估 -> 改进 -> 收敛",
      ":::",
    ].join("\n"),
    course,
  );
  assert.deepEqual(issues, []);
});

test("validateDisciplineMix ignores non-algorithm courses and contracts without code promises", () => {
  const course = algorithmCourse();
  course.discipline = "theory-math";
  assert.deepEqual(
    validateDisciplineMix(chapter("推导章", undefined), "只有推导，没有代码。", course),
    [],
  );

  course.discipline = "algorithm-engineering";
  // No code promise → no code_mix error; but a normal-depth chapter without
  // any figure still gets the figure-floor warning.
  const conceptIssues = validateDisciplineMix(
    chapter("概念章", {
      chapterTitle: "概念章",
      requiredTopics: ["概念辨析"],
      bridgeFromPrevious: "承接",
      bridgeToNext: "铺垫",
      forbiddenEarlyTopics: [],
      requiredExamples: ["手算例子"],
      requiredFormulas: [],
    }),
    "没有代码的概念章。",
    course,
  );
  assert.ok(!conceptIssues.some((issue) => issue.check === "discipline.code_mix"), JSON.stringify(conceptIssues));
  assert.ok(conceptIssues.some((issue) => issue.check === "discipline.figure_floor"), JSON.stringify(conceptIssues));
});

test("validateDisciplineMix warns when an algorithm core chapter has no figure", () => {
  const course = algorithmCourse();
  const coreChapter = chapter("策略梯度", {
    chapterTitle: "策略梯度",
    requiredTopics: ["策略梯度定理"],
    bridgeFromPrevious: "承接",
    bridgeToNext: "铺垫",
    forbiddenEarlyTopics: [],
    requiredExamples: ["推导"],
    requiredFormulas: [],
  });
  coreChapter.depthWeight = "core";

  const issues = validateDisciplineMix(coreChapter, "只有文字讲解。", course);
  assert.ok(issues.some((issue) => issue.check === "discipline.figure_floor"), JSON.stringify(issues));

  const withFigure = validateDisciplineMix(
    coreChapter,
    "文字讲解。\n:::learnbyai-figure\ncaption: 流程\nprompt: 画流程\ndiagramSpec: A -> B\n:::",
    course,
  );
  assert.ok(!withFigure.some((issue) => issue.check === "discipline.figure_floor"), JSON.stringify(withFigure));

  // Light chapters (intro/conclusion) are exempt from the figure floor.
  coreChapter.depthWeight = "light";
  assert.ok(
    !validateDisciplineMix(coreChapter, "只有文字讲解。", course).some((issue) => issue.check === "discipline.figure_floor"),
  );
});
