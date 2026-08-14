import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCourseBiblePrompt,
  buildCourseSkeletonPrompt,
} from "../../src/lib/prompts/coursePlanner";
import { buildChapterReviewPrompt } from "../../src/lib/prompts/chapterReviewer";
import type { CourseSkeleton } from "../../src/lib/prompts/coursePlanner";
import type { Chapter, Course } from "../../src/lib/types";

const input = {
  topic: "强化学习",
  goal: "掌握核心算法",
  background: "有基础",
  styles: [],
  learningMode: "guided" as const,
  chapterCount: 6,
  difficulty: "intermediate" as const,
};

const skeleton: CourseSkeleton = {
  profile: "路线",
  chapters: [
    { title: "引言", description: "背景", purpose: "引入", connectionFromPrevious: "起点", setupForNext: "铺垫", depth: "light", time: { readingMinutes: 60, exerciseMinutes: 30, practiceMinutes: 30, extensionMinutes: 15 } },
    { title: "马尔可夫决策过程", description: "MDP", purpose: "讲透", connectionFromPrevious: "承接", setupForNext: "铺垫", depth: "core", time: { readingMinutes: 60, exerciseMinutes: 30, practiceMinutes: 30, extensionMinutes: 15 } },
    { title: "总结与展望", description: "收尾", purpose: "回顾", connectionFromPrevious: "承接", setupForNext: "终点", depth: "light", time: { readingMinutes: 60, exerciseMinutes: 30, practiceMinutes: 30, extensionMinutes: 15 } },
  ],
};

test("skeleton prompt requires a discipline profile and forbids years in titles", () => {
  const prompt = buildCourseSkeletonPrompt({ ...input, contentMode: "textbook" });
  assert.ok(prompt.includes('"discipline"'), prompt);
  assert.ok(prompt.includes("algorithm-engineering"), prompt);
  assert.ok(prompt.includes("禁止进入章节标题"), prompt);
});

test("bible prompt requires a polished goalStatement", () => {
  const prompt = buildCourseBiblePrompt(input, skeleton);
  assert.ok(prompt.includes('"goalStatement"'), prompt);
  assert.ok(prompt.includes("封面副标题与前言"), prompt);
});

test("reviewer prompt requires named concepts and suspect grounding", () => {
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
  const chapter = { id: "ch", title: "多臂老虎机", description: "" } as unknown as Chapter;
  const prompt = buildChapterReviewPrompt(course, chapter, "正文。");
  assert.ok(prompt.includes("namedConcepts"), prompt);
  assert.ok(prompt.includes("suspectConcepts"), prompt);
  assert.ok(prompt.includes("查无出处"), prompt);
});
