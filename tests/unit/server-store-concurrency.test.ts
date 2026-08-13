import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/lib/serverStore.ts", "utf8");

test("chapter persistence serializes only the course update and refreshes stale snapshots", () => {
  assert.match(source, /const courseUpdateLocks = new Map/u);
  assert.match(source, /return withCourseUpdateLock\(course\.id/u);
  assert.match(source, /const latestCourse = await getServerCourse\(course\.id,\s*request\) \?\? course/u);
  assert.match(source, /return saveServerChapterUpdate\(\{ \.\.\.latestCourse, chapters \}, chapterId, request\)/u);
  assert.match(source, /chapter update owns its section mirror/iu);
});

test("course persistence retries transient Supabase gateway failures", () => {
  assert.match(source, /const maxAttempts = typeof operation === "function" \? 3 : 1/u);
  assert.match(source, /isTransientSupabaseError/u);
  assert.match(source, /invalid response\|upstream\|bad gateway/u);
  assert.match(source, /"Persist chapter",\s*\(\) => supabase\.from\("chapters"\)\.upsert/u);
});

test("lease refresh never overwrites a newer harness checkpoint with a stale payload", () => {
  const refreshBlock = source.slice(
    source.indexOf("export async function refreshServerGenerationJobLease"),
    source.indexOf("export async function claimServerGenerationJob"),
  );
  assert.match(refreshBlock, /\.\.\.\(localGenerationJobs\.get\(jobId\) \?\? \{\}\)/u);
  assert.doesNotMatch(refreshBlock, /\.update\(\{[\s\S]*payload:\s*refreshed/u);
});
