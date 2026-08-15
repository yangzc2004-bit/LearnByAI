import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompanionProgress } from "../../src/lib/types";

// Isolate the local beta store BEFORE the dynamic imports below resolve the
// store path at module load (see LEARNBYAI_LOCAL_STORE_PATH in serverStore).
const sandboxDir = mkdtempSync(join(tmpdir(), "learnbyai-companion-cas-"));
process.env.LEARNBYAI_LOCAL_STORE_PATH = join(sandboxDir, "store.json");

test.after(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

let storeModule: typeof import("../../src/lib/serverStore") | undefined;
async function loadStore() {
  storeModule ??= await import("../../src/lib/serverStore");
  return storeModule;
}

const USER = "user-progress-merge";
const COURSE = "course-progress-merge";
const CHAPTER = "chapter-progress-merge";

function progressRow(id: string, updatedAt: string, quizScore = 0): CompanionProgress {
  return {
    id,
    userId: USER,
    courseId: COURSE,
    chapterId: CHAPTER,
    completed: true,
    quizScore,
    quizTotal: 4,
    bestScore: quizScore,
    updatedAt,
  };
}

function requestFor(user: string) {
  return new Request("http://localhost/test", {
    headers: { "x-learnbyai-user-id": user },
  });
}

test("companion progress list collapses same-chapter rows to one, latest write wins", async () => {
  const store = await loadStore();
  const request = requestFor(USER);
  // Two rows for the SAME chapter with DIFFERENT ids (the reported bug: the
  // old table and new table use different ids for the same chapter). The
  // local fallback stamps updatedAt with the write time, so the latest write
  // is the newest row.
  await store.saveServerLectureProgress(progressRow("legacy-row-id", "2026-08-14T10:00:00.000Z", 1), request);
  await store.saveServerLectureProgress(progressRow("current-row-id", "2026-08-14T12:00:00.000Z", 3), request);

  const list = await store.listServerLectureProgressForCourse(COURSE, request);
  assert.equal(list.length, 1, `must collapse to one row per chapter, got ${list.length}`);
  assert.equal(list[0]!.chapterId, CHAPTER);
  assert.equal(list[0]!.id, "current-row-id", "the latest-written row must win");
  assert.equal(list[0]!.quizScore, 3);

  const single = await store.getServerLectureProgress(CHAPTER, request);
  assert.equal(single?.id, "current-row-id", "single-chapter read must prefer the newest row");
});

test("Supabase progress merge is keyed by chapterId with the new table first", () => {
  const source = readFileSync("src/lib/serverStore.ts", "utf8");
  const start = source.indexOf("const byChapter = new Map<string, CompanionProgress>()");
  const endMarker = "return [...byChapter.values()]";
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "merge block not found in serverStore");
  const mergeSection = source.slice(start, end);
  assert.match(mergeSection, /byChapter\.get\(progress\.chapterId\)/u, "merge key must be chapterId, not id");
  assert.match(mergeSection, /Date\.parse\(progress\.updatedAt\) >= Date\.parse\(existing\.updatedAt\)/u, "same-source duplicates compare updatedAt");
  assert.ok(
    mergeSection.indexOf("current") < mergeSection.indexOf("legacy"),
    "new-table rows must be merged first so they take precedence",
  );
  assert.match(mergeSection, /if \(!byChapter\.has\(progress\.chapterId\)\)/u, "legacy rows only fill gaps");
});

test("companion/answers CAS helpers route through the guarded cross-process RPC", () => {
  const source = readFileSync("src/lib/serverStore.ts", "utf8");
  assert.match(source, /apply_chapter_update_guarded/u);
  assert.match(source, /expected_body_hash: options\?\.expectedBodyHash \?\? null/u);
  assert.match(source, /throw new ChapterUpdateConflictError\(chapterId\)/u);
  assert.match(source, /expectedBodyHash: expectedContentHash/u, "CAS helpers must pass the expected hash");
  assert.match(source, /error instanceof ChapterUpdateConflictError/u, "CAS helpers must translate the conflict into applied:false");
  assert.match(source, /const newBodyHash = hashChapterContent\(getChapterBody\(chapter\)\)/u, "chapter updates must persist the new body hash");
  assert.match(source, /new_body_hash: newBodyHash/u);
});

test("active-guide job conflict recovery covers companion-guide and legacy lecture types", () => {
  const source = readFileSync("src/lib/serverStore.ts", "utf8");
  assert.match(source, /job\.type === "companion-guide" \|\| job\.type === "lecture"/u);
  assert.match(source, /generation_jobs_active_\(course\|chapter\|guide\)_idx/u);

  const route = readFileSync("src/app/api/chapters/[id]/companion/route.ts", "utf8");
  assert.match(route, /persistedJob\.id !== job\.id/u, "the route must return the existing job on 23505 recovery");
  assert.match(route, /publicGenerationJob\(persistedJob\)/u);

  const schema = readFileSync("supabase/schema.sql", "utf8");
  assert.match(schema, /generation_jobs_active_guide_idx/u);
  assert.match(schema, /type in \('companion-guide', 'lecture'\)/u);
});

test("guarded RPC is service-role-only and surgical in the schema", () => {
  const schema = readFileSync("supabase/schema.sql", "utf8");
  assert.match(schema, /create or replace function public\.apply_chapter_update_guarded\(/u);
  assert.match(schema, /jsonb_array_elements\(c\.payload->'chapters'\)/u, "course payload update must target the single chapter element");
  assert.match(schema, /and course_id = target_course_id/u, "RPC must verify the chapter belongs to the course");
  assert.match(schema, /new_title text/u);
  assert.match(schema, /new_status text/u);
  assert.match(schema, /new_order_index integer/u);
  assert.match(schema, /version = current_version \+ 1/u, "chapter updates must increment the course version");
  assert.match(schema, /delete from public\.sections\s+where chapter_id = target_chapter_id/u, "section mirror must be synced inside the RPC");
  assert.match(schema, /revoke execute on function public\.apply_chapter_update_guarded/u);
  assert.match(schema, /grant execute on function public\.apply_chapter_update_guarded\([^)]*\) to service_role/u);
});

test("whole-course writes use a version CAS and keep all mirrors in one transaction", () => {
  const schema = readFileSync("supabase/schema.sql", "utf8");
  assert.match(schema, /alter table public\.courses add column if not exists version integer not null default 1/u);
  assert.match(schema, /create or replace function public\.save_course_guarded\(/u);
  assert.match(schema, /current_version <> expected_version/u);
  assert.match(schema, /with incoming_sections as/u, "sections mirror must be rebuilt inside save_course_guarded");
  assert.match(schema, /with incoming_reports as/u, "chapter quality reports must be persisted inside save_course_guarded");

  const source = readFileSync("src/lib/serverStore.ts", "utf8");
  assert.match(source, /select\("payload, version"\)/u, "course reads must return the optimistic-lock version");
  assert.match(source, /typeof savedVersion !== "number" \|\| savedVersion < 1/u);
});

test("TutorPanel composer is controlled and syncs with initialQuestion", () => {
  const source = readFileSync("src/components/reader/TutorPanel.tsx", "utf8");
  assert.match(source, /value=\{composerValue\}/u, "textarea must be controlled");
  assert.match(source, /onChange=\{\(event\) => setComposerValue\(event\.currentTarget\.value\)\}/u);
  assert.match(source, /if \(initialQuestion\) setComposerValue\(initialQuestion\)/u, "prefill must follow initialQuestion changes");
  assert.doesNotMatch(source, /defaultValue=\{initialQuestion\}/u);
});
