import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Course } from "../../src/lib/types";

// Isolate the local beta store BEFORE the dynamic imports below resolve the
// store path at module load (see LEARNBYAI_LOCAL_STORE_PATH in serverStore).
const sandboxDir = mkdtempSync(join(tmpdir(), "learnbyai-companion-compat-"));
const storePath = join(sandboxDir, "store.json");
process.env.LEARNBYAI_LOCAL_STORE_PATH = storePath;

test.after(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

type StoreModule = typeof import("../../src/lib/serverStore");
type NormalizeModule = typeof import("../../src/lib/normalizeCourse");
let storeModule: StoreModule | undefined;
let normalizeModule: NormalizeModule | undefined;

async function loadModules() {
  storeModule ??= await import("../../src/lib/serverStore");
  normalizeModule ??= await import("../../src/lib/normalizeCourse");
  return { store: storeModule, normalize: normalizeModule };
}

const COURSE_ID = "course-companion";
const CHAPTER_ID = "chapter-companion";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function makeCourse(body: string): Course {
  return {
    id: COURSE_ID,
    userId: "user-companion",
    topic: "伴学兼容",
    goal: "测试",
    background: "",
    styles: [],
    learningMode: "standard",
    chapterCount: 1,
    difficulty: "intermediate",
    profile: "",
    contentMode: "textbook",
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
        id: CHAPTER_ID,
        title: "第一章",
        description: "",
        time: { readingMinutes: 1, exerciseMinutes: 1, practiceMinutes: 1, extensionMinutes: 1 },
        status: "ready",
        content: body,
      },
    ],
    createdAt: "2026-08-15T00:00:00.000Z",
  } as unknown as Course;
}

test("normalizeCourse maps a legacy chapter.lecture payload onto companionGuide", async () => {
  const { normalize } = await loadModules();
  const legacy = makeCourse("## 3.1 节\n正文。");
  legacy.chapters[0].lecture = { status: "ready", learningObjectives: ["目标一"], generatedAt: "2026-08-15T00:00:00.000Z" };
  delete legacy.chapters[0].companionGuide;

  const normalized = normalize.normalizeCourse(legacy);
  assert.equal(normalized.chapters[0].companionGuide?.status, "ready");
  assert.equal(normalized.chapters[0].companionGuide?.learningObjectives?.[0], "目标一");
  // Deprecated mirror stays readable for one release cycle.
  assert.equal(normalized.chapters[0].lecture?.status, "ready");
});

test("updates written through the legacy lecture patch persist as companionGuide only", async () => {
  const { store } = await loadModules();
  await store.saveServerCourse(makeCourse("## 3.1 节\n正文。"));
  await store.updateServerChapter(makeCourse("## 3.1 节\n正文。"), CHAPTER_ID, { lecture: { status: "queued" } });

  const raw = JSON.parse(readFileSync(storePath, "utf8"));
  const persisted = (raw.courses as Course[]).find((course) => course.id === COURSE_ID);
  const chapter = persisted?.chapters[0];
  assert.equal(chapter?.lecture, undefined, "deprecated lecture key must never reach storage");
  assert.equal(chapter?.companionGuide?.status, "queued");

  const reloaded = await store.getServerCourse(COURSE_ID);
  assert.equal(reloaded?.chapters[0].companionGuide?.status, "queued");
  assert.equal(reloaded?.chapters[0].lecture?.status, "queued", "in-memory mirror keeps legacy readers working");
});

test("companion guide write applies only when the content hash matches", async () => {
  const { store } = await loadModules();
  const bodyA = "## 3.1 正文A\n内容。";
  await store.saveServerCourse(makeCourse(bodyA));

  const applied = await store.updateChapterCompanionIfContentHashMatches(
    COURSE_ID, CHAPTER_ID, sha256(bodyA),
    { status: "ready", learningObjectives: ["目标一"], sourceContentHash: sha256(bodyA) },
  );
  assert.equal(applied.applied, true);

  const refused = await store.updateChapterCompanionIfContentHashMatches(
    COURSE_ID, CHAPTER_ID, sha256("另一份正文"),
    { status: "ready", learningObjectives: ["目标二"], sourceContentHash: sha256("另一份正文") },
  );
  assert.equal(refused.applied, false);

  const reloaded = await store.getServerCourse(COURSE_ID);
  assert.equal(reloaded?.chapters[0].companionGuide?.learningObjectives?.[0], "目标一");
});

test("chapter regeneration clears a guide generated from the old body (reverse race)", async () => {
  const { store } = await loadModules();
  const bodyA = "## 3.1 正文A\n内容。";
  await store.saveServerCourse(makeCourse(bodyA));
  await store.updateChapterCompanionIfContentHashMatches(
    COURSE_ID, CHAPTER_ID, sha256(bodyA),
    { status: "ready", sourceContentHash: sha256(bodyA) },
  );

  await store.updateServerChapter(makeCourse(bodyA), CHAPTER_ID, { content: "## 3.1 正文B\n重新生成。", sections: undefined });
  const reloaded = await store.getServerCourse(COURSE_ID);
  assert.equal(reloaded?.chapters[0].companionGuide, undefined);
  assert.equal(reloaded?.chapters[0].lecture, undefined);
});

test("read path hides a guide whose source hash no longer matches (defense in depth)", async () => {
  const { store } = await loadModules();
  const bodyA = "## 3.1 正文A\n内容。";
  await store.saveServerCourse(makeCourse(bodyA));
  // An explicit guide patch bypasses the write-side clear to simulate a
  // regeneration that never ran the guard.
  await store.updateServerChapter(makeCourse(bodyA), CHAPTER_ID, {
    content: "## 3.1 正文B\n重新生成。",
    sections: undefined,
    companionGuide: { status: "ready", sourceContentHash: sha256(bodyA) },
  });

  const reloaded = await store.getServerCourse(COURSE_ID);
  assert.equal(reloaded?.chapters[0].companionGuide, undefined, "read guard hides the stale guide");
});
