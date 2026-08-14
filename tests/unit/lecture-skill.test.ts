import assert from "node:assert/strict";
import test from "node:test";
import type { Chapter, Course } from "../../src/lib/types";
import { buildChapterWriterPrompt } from "../../src/lib/prompts/chapterWriter";
import { buildChapterReviewPrompt } from "../../src/lib/prompts/chapterReviewer";
import { buildCourseSkeletonPrompt } from "../../src/lib/prompts/coursePlanner";
import type { CoursePlannerInput } from "../../src/lib/prompts/coursePlanner";
import { buildIllustrationPlanPrompt } from "../../src/lib/prompts/illustrator";

function makeCourse(mode: "lecture" | "textbook"): Course {
  return {
    id: "course-lecture-skill",
    userId: "user-lecture-skill",
    topic: "强化学习",
    goal: "掌握核心算法",
    background: "",
    styles: ["rigor"],
    learningMode: "standard",
    chapterCount: 6,
    difficulty: "intermediate",
    profile: "",
    contentMode: mode,
    courseBible: {
      targetLearner: "",
      finalOutcomes: [],
      teachingStyle: "",
      prerequisites: [],
      globalNarrative: "",
      terminology: [],
      notation: [],
      chapterDependencies: [],
    },
    chapters: [
      {
        id: "ch1",
        title: "动态规划",
        description: "策略评估与迭代",
        time: { readingMinutes: 20, exerciseMinutes: 10, practiceMinutes: 5, extensionMinutes: 5 },
        status: "ready",
        content: "## 问题导入\n为什么要学动态规划。",
      },
    ],
    createdAt: "2026-08-15T00:00:00.000Z",
  } as unknown as Course;
}

const chapter = makeCourse("lecture").chapters[0] as unknown as Chapter;

function plannerInput(mode: "lecture" | "textbook"): CoursePlannerInput {
  return {
    topic: "强化学习",
    goal: "掌握核心算法",
    background: "",
    styles: ["rigor"],
    learningMode: "standard",
    chapterCount: 6,
    difficulty: "intermediate",
    contentMode: mode,
  };
}

test("lecture writer prompt injects the lecture skill, never the textbook skill", () => {
  const prompt = buildChapterWriterPrompt(makeCourse("lecture"), chapter);
  assert.ok(prompt.includes("讲义写作目标"), "lecture skill must be present");
  assert.ok(prompt.includes("问题导入"));
  assert.ok(!prompt.includes("教材写作目标"), "textbook skill must not leak into lecture mode");
});

test("textbook writer prompt keeps the textbook skill (regression)", () => {
  const prompt = buildChapterWriterPrompt(makeCourse("textbook"), chapter);
  assert.ok(prompt.includes("教材写作目标"));
  assert.ok(!prompt.includes("讲义写作目标"));
});

test("lecture reviewer rubric checks focus, teachability, repetition and length", () => {
  const prompt = buildChapterReviewPrompt(makeCourse("lecture"), chapter, "## 问题导入\n正文。");
  assert.ok(prompt.includes("聚焦度"));
  assert.ok(prompt.includes("可讲授性"));
  assert.ok(prompt.includes("重复"));
  assert.ok(prompt.includes("篇幅失控"));
  const textbook = buildChapterReviewPrompt(makeCourse("textbook"), chapter, "## 3.1 正文。");
  assert.ok(!textbook.includes("聚焦度"), "lecture rubric must not leak into textbook mode");
});

test("planner splits skeleton rules by content mode", () => {
  const lecture = buildCourseSkeletonPrompt(plannerInput("lecture"));
  assert.ok(lecture.includes("主题性「导论」"));
  assert.ok(lecture.includes("主题性「复习」"));
  assert.ok(!lecture.includes("最后一章必须是全书收尾「总结与展望」章"), "lecture must not pin the textbook framing");
  const textbook = buildCourseSkeletonPrompt(plannerInput("textbook"));
  assert.ok(textbook.includes("最后一章必须是全书收尾「总结与展望」章"));
  assert.ok(!textbook.includes("主题性「导论」"), "textbook must not gain lecture framing");
});

test("illustrator prefers explanatory structure figures for lecture mode", () => {
  const lecture = buildIllustrationPlanPrompt({
    course: makeCourse("lecture"),
    chapterTitle: "动态规划",
    chapterNumber: 1,
    content: "## 问题导入\n正文。",
  });
  assert.ok(lecture.includes("解释性结构图"));
  assert.ok(lecture.includes("讲义章节"));
  const textbook = buildIllustrationPlanPrompt({
    course: makeCourse("textbook"),
    chapterTitle: "动态规划",
    chapterNumber: 1,
    content: "## 3.1 正文。",
  });
  assert.ok(!textbook.includes("讲义模式"));
});
