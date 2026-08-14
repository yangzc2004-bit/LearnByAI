import assert from "node:assert/strict";
import test from "node:test";
import { buildExerciseAnswersPrompt, parseExerciseAnswers } from "../../src/lib/prompts/exerciseAnswers";
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
  const prompt = buildExerciseAnswersPrompt(course, chapter, "## 练习\n1. 第一题\n2. 第二题");
  assert.ok(prompt.includes("questionIndex"), prompt);
  assert.ok(prompt.includes("自查"), prompt);
  assert.ok(prompt.includes("动态规划"), prompt);
});

test("parseExerciseAnswers sorts by question index and drops duplicates/junk", () => {
  const answers = parseExerciseAnswers(
    JSON.stringify({
      answers: [
        { questionIndex: 2, answer: "第二题解答。" },
        { questionIndex: 1, answer: "第一题解答。" },
        { questionIndex: 2, answer: "重复" },
        { questionIndex: 0, answer: "越界" },
        { answer: "缺序号" },
        "not an object",
      ],
    }),
  );
  assert.deepEqual(answers, [
    { questionIndex: 1, answer: "第一题解答。" },
    { questionIndex: 2, answer: "第二题解答。" },
  ]);
  assert.deepEqual(parseExerciseAnswers("not json"), []);
});
