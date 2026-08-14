import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Course } from "../../src/lib/types";

// Isolate export/tex-project writes into a per-run temp dir. exportPaths
// resolves the store dirs at module load, so the env vars must be set
// before the dynamic import below runs.
const sandboxDir = mkdtempSync(join(tmpdir(), "learnbyai-export-blocking-"));
process.env.LEARNBYAI_EXPORT_DIR = join(sandboxDir, "exports");
process.env.LEARNBYAI_TEX_EXPORT_DIR = join(sandboxDir, "tex-projects");

after(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

type ExportsModule = typeof import("../../src/lib/exports");
let exportsModule: ExportsModule | undefined;
async function getExports(): Promise<ExportsModule> {
  exportsModule ??= await import("../../src/lib/exports");
  return exportsModule;
}

function makeCourse(chapterContent: string): Course {
  return {
    id: "course-export-block",
    userId: "user-export-block",
    contentMode: "textbook",
    topic: "导出质检",
    goal: "验证导出阻断",
    background: "单元测试",
    styles: ["rigor"],
    learningMode: "standard",
    chapterCount: 1,
    difficulty: "intermediate",
    generationProfile: "fast",
    includeRecentResearch: false,
    profile: "初学者",
    createdAt: "2026-08-15T00:00:00.000Z",
    courseBible: {
      targetLearner: "测试读者",
      finalOutcomes: ["验证导出质检阻断"],
      teachingStyle: "严谨",
      prerequisites: [],
      globalNarrative: "测试",
      goalStatement: "验证导出质检阻断逻辑",
      terminology: [],
      chapterDependencies: [],
    },
    textbookMeta: { title: "导出质检测试", language: "zh-CN", outlineStatus: "none" },
    chapters: [
      {
        id: "chapter-1",
        title: "第一章 阻断测试",
        description: "",
        time: { readingMinutes: 10, exerciseMinutes: 5, practiceMinutes: 5, extensionMinutes: 0 },
        status: "ready",
        content: chapterContent,
      },
    ],
  };
}

// A raw "\[" display-math opener leaks the \frac command into the generated
// TeX with no $ on the line: qaGeneratedTex rates it math_in_text (error) and
// XeLaTeX itself would fail on the unclosed display math.
const BLOCKING_CONTENT = "正文段落。\n\\[\\frac{1}{2} 未闭合的数学命令。";

test("direct .tex export blocks on error-level QA findings", async () => {
  const { createCourseExport, ExportQaBlockError } = await getExports();
  const course = makeCourse(BLOCKING_CONTENT);
  await assert.rejects(
    () => createCourseExport(course, "tex", "user-export-block"),
    (error: unknown) => error instanceof ExportQaBlockError && error.message.includes("阻断性"),
  );
});

test("whole-book PDF export runs the blocking gate before XeLaTeX", async () => {
  const { createCourseExport, ExportQaBlockError } = await getExports();
  const course = makeCourse(BLOCKING_CONTENT);
  await assert.rejects(
    () => createCourseExport(course, "pdf", "user-export-block"),
    (error: unknown) =>
      error instanceof ExportQaBlockError &&
      error.message.includes("阻断性") &&
      // The gate must fire BEFORE the compile: a compile failure would have
      // surfaced as a TeX compile error and been turned into the HTML
      // fallback, which is exactly the bypass this test guards against.
      !error.message.includes("TeX compile") &&
      !error.message.includes("回退"),
  );
});

test("warning-only .tex export still delivers with warnings recorded", async () => {
  const { createCourseExport } = await getExports();
  const course = makeCourse("这一行有一个未闭合的 ` 反引号残留，只是警告。");
  const job = await createCourseExport(course, "tex", "user-export-block");
  assert.equal(job.format, "tex");
  assert.equal(job.status, "succeeded");
  assert.ok(job.qaWarnings?.some((warning) => warning.includes("backtick")), JSON.stringify(job.qaWarnings));
  assert.ok(!job.qaWarnings?.some((warning) => warning.includes("[error]")), JSON.stringify(job.qaWarnings));
});

