import assert from "node:assert/strict";
import test from "node:test";
import type { Course } from "../../src/lib/types";

type ExportsModule = typeof import("../../src/lib/exports");
let exportsModule: ExportsModule | undefined;
async function loadExports() {
  exportsModule ??= await import("../../src/lib/exports");
  return exportsModule;
}

function makeCourse(mode: "lecture" | "textbook"): Course {
  return {
    id: "course-lecture-tex",
    userId: "user-lecture-tex",
    topic: "强化学习",
    goal: "掌握核心算法",
    background: "",
    styles: [],
    learningMode: "standard",
    chapterCount: 2,
    difficulty: "intermediate",
    profile: "有基础的学习者",
    contentMode: mode,
    courseBible: {
      targetLearner: "具备基础概率知识的学习者",
      finalOutcomes: ["能实现策略迭代"],
      teachingStyle: "",
      prerequisites: ["概率论基础"],
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
        content: "# 1 动态规划\n## 1.1 策略评估\n给定策略求价值函数。",
      },
      {
        id: "ch2",
        title: "蒙特卡洛方法",
        description: "",
        time: { readingMinutes: 15, exerciseMinutes: 5, practiceMinutes: 0, extensionMinutes: 0 },
        status: "ready",
        content: "# 2 蒙特卡洛方法\n## 2.1 采样估计\n正文。",
      },
    ],
    createdAt: "2026-08-15T00:00:00.000Z",
  } as unknown as Course;
}

test("toTex routes lecture courses to the ctexart 电子讲义 template", async () => {
  const exportsMod = await loadExports();
  const tex = await exportsMod.toTex(makeCourse("lecture"));
  assert.ok(tex.includes("LearnByAI · 电子讲义"), "cover must brand the lecture document");
  assert.ok(tex.includes("ctexart"), "lecture document uses the article class");
  assert.ok(tex.includes("第 1 讲 · 动态规划"), "chapters become numbered lectures");
  assert.ok(tex.includes("第 2 讲 · 蒙特卡洛方法"));
  assert.ok(tex.includes("\\numberwithin{figure}{section}"), "figures numbered per lecture");
  assert.ok(tex.includes("\\numberwithin{equation}{section}"));
  assert.ok(tex.includes("\\refstepcounter{section}\\label{lecture-1}"));
  assert.ok(tex.includes("总学习时间约 60 分钟"));
  assert.ok(tex.includes("课程目标"));
  assert.ok(tex.includes("适用基础"));
  assert.ok(!tex.includes("个性化学习教材"), "lecture cover must never use textbook copy");
  assert.ok(!tex.includes("ctexbook"));
  assert.ok(!tex.includes("\\chapter{"));
});

test("lecture content headings shift below the 讲 level and h1 is dropped", async () => {
  const exportsMod = await loadExports();
  const tex = await exportsMod.toTex(makeCourse("lecture"));
  assert.ok(tex.includes("\\subsection{策略评估}"), "h2 becomes a subsection under the lecture");
  assert.ok(!tex.includes("\\section{策略评估}"));
  assert.ok(!tex.includes("\\section{动态规划}"), "chapter h1 is replaced by the 讲 heading");
});

test("textbook TeX keeps the ctexbook template (regression)", async () => {
  const exportsMod = await loadExports();
  const tex = await exportsMod.toTex(makeCourse("textbook"));
  assert.ok(tex.includes("个性化学习教材"));
  assert.ok(tex.includes("ctexbook"));
  assert.ok(!tex.includes("LearnByAI · 电子讲义"));
});

test("markdownToTex lectureMode maps h2 to subsection; default maps to section", async () => {
  const exportsMod = await loadExports();
  const body = "## 3.1 策略评估\n给定策略求价值函数。";
  const lecture = await exportsMod.markdownToTex(body, { lectureMode: true });
  assert.ok(lecture.includes("\\subsection{策略评估}"));
  assert.ok(!lecture.includes("\\section{策略评估}"));
  const textbook = await exportsMod.markdownToTex(body);
  assert.ok(textbook.includes("\\section{策略评估}"));
});
