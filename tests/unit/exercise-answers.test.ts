import assert from "node:assert/strict";
import test from "node:test";
import { buildExerciseAnswersPrompt, countExerciseQuestions, parseExerciseAnswers } from "../../src/lib/prompts/exerciseAnswers";
import type { Chapter, Course } from "../../src/lib/types";

const course = {
  id: "c",
  topic: "强化学习",
  goal: "掌握核心算法",
  background: "",
  styles: [],
  learningMode: "guided",
  chapterCount: 3,
  difficulty: "intermediate",
  profile: "",
  courseBible: {
    targetLearner: "",
    finalOutcomes: [],
    teachingStyle: "",
    prerequisites: [],
    globalNarrative: "",
    terminology: [],
    chapterDependencies: [],
  },
  chapters: [],
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Course;

const chapter = {
  id: "ch",
  title: "动态规划",
  description: "",
  time: { readingMinutes: 10, exerciseMinutes: 10, practiceMinutes: 10, extensionMinutes: 10 },
} as Chapter;

test("buildExerciseAnswersPrompt demands per-question answers with self-check", () => {
  const prompt = buildExerciseAnswersPrompt(course, chapter, "## 练习\n1. 第一题\n2. 第二题", 2);
  assert.ok(prompt.includes("questionIndex"), prompt);
  assert.ok(prompt.includes("自查"), prompt);
  assert.ok(prompt.includes("动态规划"), prompt);
  assert.ok(prompt.includes("共 2 道题"), prompt);
  assert.ok(prompt.includes("最大 2"), prompt);
});

test("parseExerciseAnswers sorts by question index and drops duplicates/junk/out-of-range", () => {
  const answers = parseExerciseAnswers(
    JSON.stringify({
      answers: [
        { questionIndex: 2, answer: "第二题解答。" },
        { questionIndex: 1, answer: "第一题解答。" },
        { questionIndex: 2, answer: "重复" },
        { questionIndex: 0, answer: "越界" },
        { questionIndex: 99, answer: "幻觉序号，正文只有 2 题" },
        { answer: "缺序号" },
        "not an object",
      ],
    }),
    2,
  );
  assert.deepEqual(answers, [
    { questionIndex: 1, answer: "第一题解答。" },
    { questionIndex: 2, answer: "第二题解答。" },
  ]);
  assert.deepEqual(parseExerciseAnswers("not json", 2), []);
});

test("countExerciseQuestions counts numbered items in the first exercise section", () => {
  const content = [
    "## 2.3 正文小节",
    "1. 这不是练习",
    "## 练习",
    "1. 第一题",
    "2. 第二题",
    "",
    "### 拓展练习",
    "3. 不计入主练习",
    "",
    "正文结尾。",
  ].join("\n");
  assert.equal(countExerciseQuestions(content), 2);
});

test("countExerciseQuestions returns 0 without an exercise section", () => {
  assert.equal(countExerciseQuestions("## 总结\n1. 要点\n2. 要点"), 0);
  assert.equal(countExerciseQuestions("## 课后练习\n1. 一题"), 1);
});
