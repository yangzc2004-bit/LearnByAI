import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Course, ExerciseAnswer } from "../../src/lib/types";

// Isolate the local beta store BEFORE the dynamic imports below resolve the
// store path at module load (see LEARNBYAI_LOCAL_STORE_PATH in serverStore).
const sandboxDir = mkdtempSync(join(tmpdir(), "learnbyai-answers-runner-"));
process.env.LEARNBYAI_LOCAL_STORE_PATH = join(sandboxDir, "store.json");

test.after(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

type StoreModule = typeof import("../../src/lib/serverStore");
type RunnerModule = typeof import("../../src/lib/generationRunner");
type JobsModule = typeof import("../../src/lib/jobs");

let storeModule: StoreModule | undefined;
let runnerModule: RunnerModule | undefined;
let jobsModule: JobsModule | undefined;

async function loadModules() {
  storeModule ??= await import("../../src/lib/serverStore");
  runnerModule ??= await import("../../src/lib/generationRunner");
  jobsModule ??= await import("../../src/lib/jobs");
  return { store: storeModule, runner: runnerModule, jobs: jobsModule };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function makeCourse(chapterContent: string): Course {
  return {
    id: "course-answers-runner",
    userId: "user-answers-runner",
    topic: "答案任务竞态",
    goal: "测试",
    background: "",
    styles: ["rigor"],
    learningMode: "standard",
    chapterCount: 1,
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
    chapters: [
      {
        id: "chapter-answers-runner",
        title: "第一章",
        description: "",
        time: { readingMinutes: 1, exerciseMinutes: 1, practiceMinutes: 1, extensionMinutes: 1 },
        status: "ready",
        content: chapterContent,
      },
    ],
    createdAt: "2026-08-15T00:00:00.000Z",
  } as unknown as Course;
}

const CHAPTER_ID = "chapter-answers-runner";
const COURSE_ID = "course-answers-runner";

test("atomic answers write applies when the content hash matches", async () => {
  const { store } = await loadModules();
  const bodyA = "## 练习\n1. 第一题\n正文。";
  await store.saveServerCourse(makeCourse(bodyA));

  const answers: ExerciseAnswer[] = [{ questionIndex: 1, answer: "解答。" }];
  const result = await store.updateChapterAnswersIfContentHashMatches(COURSE_ID, CHAPTER_ID, sha256(bodyA), answers);
  assert.equal(result.applied, true);

  const reloaded = await store.getServerCourse(COURSE_ID);
  assert.deepEqual(reloaded?.chapters[0]?.exerciseAnswers, answers);
  assert.equal(reloaded?.chapters[0]?.content, bodyA);
});

test("atomic answers write refuses when the content changed mid-flight (the race)", async () => {
  const { store } = await loadModules();
  const bodyA = "## 练习\n1. 旧版题目\n正文。";
  const bodyB = "## 练习\n1. 重新生成后的新题目\n正文已更新。";
  await store.saveServerCourse(makeCourse(bodyA));

  // Simulate a chapter regeneration landing while the answer call is in flight.
  await store.updateServerChapter(makeCourse(bodyA), CHAPTER_ID, { content: bodyB, sections: undefined });

  const answers: ExerciseAnswer[] = [{ questionIndex: 1, answer: "旧版题目的解答。" }];
  const result = await store.updateChapterAnswersIfContentHashMatches(COURSE_ID, CHAPTER_ID, sha256(bodyA), answers);
  assert.equal(result.applied, false);

  const reloaded = await store.getServerCourse(COURSE_ID);
  assert.equal(reloaded?.chapters[0]?.content, bodyB, "new content must survive");
  assert.equal(reloaded?.chapters[0]?.exerciseAnswers, undefined, "stale answers must not be written");
});

test("runner supersedes a stale answer job and a retry re-anchors to the current content", async () => {
  const { store, runner, jobs } = await loadModules();
  delete process.env.AI_API_KEY; // keep the dispatcher on its mock path
  const bodyA = "## 练习\n1. 当前题目\n正文。";
  await store.saveServerCourse(makeCourse(bodyA));

  const staleJob = jobs.createGenerationJob({
    type: "exercise-answers",
    courseId: COURSE_ID,
    chapterId: CHAPTER_ID,
    userId: "user-answers-runner",
    activeAgent: "REVIEWER",
    status: "queued",
    message: "练习详解已排队。",
    sourceContentHash: sha256("旧版正文"),
  });
  await store.saveServerGenerationJob(staleJob);

  const first = await runner.runExerciseAnswersGenerationJob({ jobId: staleJob.id });
  assert.equal(first.status, 409, JSON.stringify(first));
  assert.equal(first.job?.status, "superseded");
  const afterSupersede = await store.getServerCourse(COURSE_ID);
  assert.equal(afterSupersede?.chapters[0]?.content, bodyA);
  assert.equal(afterSupersede?.chapters[0]?.exerciseAnswers, undefined);

  // An explicit retry re-anchors the job to the CURRENT content instead of
  // being discarded again (mock dispatcher returns no answers → clean succeed).
  const second = await runner.runExerciseAnswersGenerationJob({ jobId: staleJob.id, retry: true });
  assert.equal(second.error, undefined, JSON.stringify(second));
  assert.equal(second.job?.status, "succeeded");
  assert.equal(second.job?.sourceContentHash, sha256(bodyA), "retry must re-anchor the fingerprint");
  const afterRetry = await store.getServerCourse(COURSE_ID);
  assert.equal(afterRetry?.chapters[0]?.content, bodyA);
});

test("provider failure fails only the answer job and leaves the chapter untouched", async () => {
  const { store, runner, jobs } = await loadModules();
  const previousKey = process.env.AI_API_KEY;
  const previousBase = process.env.AI_API_BASE_URL;
  const previousMock = process.env.AI_MOCK_MODE;
  // Force the REAL provider path against an unreachable address so the
  // dispatch fails fast (connection refused) with no external network use.
  process.env.AI_API_KEY = "test-key";
  process.env.AI_API_BASE_URL = "http://127.0.0.1:1";
  delete process.env.AI_MOCK_MODE;
  try {
    const body = "## 练习\n1. 第一题\n2. 第二题\n正文。";
    await store.saveServerCourse(makeCourse(body));

    const job = jobs.createGenerationJob({
      type: "exercise-answers",
      courseId: COURSE_ID,
      chapterId: CHAPTER_ID,
      userId: "user-answers-runner",
      activeAgent: "REVIEWER",
      status: "queued",
      message: "练习详解已排队。",
      sourceContentHash: sha256(body),
    });
    await store.saveServerGenerationJob(job);

    const result = await runner.runExerciseAnswersGenerationJob({ jobId: job.id });
    assert.ok(result.error, JSON.stringify(result));
    assert.equal(result.job?.status, "failed");
    assert.match(result.job?.error ?? "", /练习详解生成失败/);

    const reloaded = await store.getServerCourse(COURSE_ID);
    assert.equal(reloaded?.chapters[0]?.status, "ready", "chapter status must stay ready");
    assert.equal(reloaded?.chapters[0]?.content, body);
    assert.equal(reloaded?.chapters[0]?.exerciseAnswers, undefined);
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.AI_API_BASE_URL; else process.env.AI_API_BASE_URL = previousBase;
    if (previousMock === undefined) delete process.env.AI_MOCK_MODE; else process.env.AI_MOCK_MODE = previousMock;
  }
});

