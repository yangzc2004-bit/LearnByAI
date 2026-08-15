import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/lib/serverStore.ts", "utf8");

test("chapter persistence serializes only the course update and refreshes stale snapshots", () => {
  assert.match(source, /const courseUpdateLocks = new Map/u);
  assert.match(source, /return withCourseUpdateLock\(course\.id/u);
  assert.match(source, /const latestCourse = await getServerCourse\(course\.id,\s*request\) \?\? course/u);
  assert.match(source, /return saveServerChapterUpdate\(\{ \.\.\.latestCourse, chapters \}, chapterId, request\)/u);
  assert.match(source, /apply_chapter_update_guarded/u);
  assert.match(source, /new_title: chapter\.title/u);
  assert.match(source, /new_status: chapter\.status \?\? "pending"/u);
  assert.match(source, /new_order_index: chapterIndex/u);
});

test("course persistence routes whole-course writes through the version CAS RPC", () => {
  assert.match(source, /supabase\.rpc\("save_course_guarded"/u);
  assert.match(source, /expected_version: nextCourse\.version \?\? null/u);
  assert.match(source, /throw new CourseUpdateConflictError\(nextCourse\.id\)/u);
  assert.match(source, /const maxAttempts = typeof operation === "function" \? 3 : 1/u);
  assert.match(source, /isTransientSupabaseError/u);
  assert.match(source, /invalid response\|upstream\|bad gateway/u);
});

test("lease refresh never overwrites a newer harness checkpoint with a stale payload", () => {
  const refreshBlock = source.slice(
    source.indexOf("export async function refreshServerGenerationJobLease"),
    source.indexOf("export async function claimServerGenerationJob"),
  );
  assert.match(refreshBlock, /\.\.\.\(localGenerationJobs\.get\(jobId\) \?\? \{\}\)/u);
  assert.doesNotMatch(refreshBlock, /\.update\(\{[\s\S]*payload:\s*refreshed/u);
});
