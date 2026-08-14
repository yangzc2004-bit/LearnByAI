import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("chapter generation no longer awaits exercise answers inline", () => {
  const src = readFileSync("src/lib/maol/client.ts", "utf8");
  // Both the full pipeline and the draft-review pipeline must return the
  // chapter WITHOUT waiting on the answer provider.
  assert.doesNotMatch(src, /await generateExerciseAnswers/u);
  assert.match(src, /export async function generateExerciseAnswers/u);
  // Provider failures are surfaced as { answers: [], error } so the
  // background job can be marked failed instead of succeeded.
  assert.match(src, /ExerciseAnswersGenerationResult/u);
  assert.match(src, /error: safeErrorMessage\(error, "REVIEWER failed"\)/u);
});

test("generation runner queues answers as a separate background job after ready", () => {
  const src = readFileSync("src/lib/generationRunner.ts", "utf8");
  assert.match(src, /type: "exercise-answers"/u);
  assert.match(src, /message: "练习详解已排队，将在后台生成，不影响章节阅读。"/u);
  assert.match(src, /export async function runExerciseAnswersGenerationJob/u);
  // The background runner never patches status/content directly — the only
  // write path is the atomic hash-guarded answers write in the store.
  const storeSrc = readFileSync("src/lib/serverStore.ts", "utf8");
  assert.ok(storeSrc.includes("exerciseAnswers, exerciseAnswersSourceContentHash: expectedContentHash"), "store must only write exerciseAnswers (with source hash)");
  assert.match(storeSrc, /updateChapterAnswersIfContentHashMatches/u);
  // Content-fingerprint anchoring: the job is pinned to the chapter version
  // it was queued for, and stale jobs are superseded instead of written.
  assert.match(src, /sourceContentHash: hashChapterContent\(input\.content\)/u);
  assert.match(src, /status: "superseded"/u);
  // The final fingerprint check + write must be the atomic store helper.
  assert.match(src, /updateChapterAnswersIfContentHashMatches\(/u);
  // Provider failures fail ONLY the answer sub-task.
  assert.match(src, /if \(result\.error\)/u);
});

test("generation worker dispatches exercise-answers jobs", () => {
  const src = readFileSync("src/lib/generationWorker.ts", "utf8");
  assert.match(src, /claimed\.type === "exercise-answers"/u);
});


test("superseded answer jobs are labeled and retryable", () => {
  const coursePage = readFileSync("src/app/courses/[id]/page.tsx", "utf8");
  assert.match(coursePage, /superseded: "\\u5df2\\u4f5c\\u5e9f"/u);
  const adminData = readFileSync("src/lib/adminData.ts", "utf8");
  assert.match(adminData, /job\.status !== "failed" && job\.status !== "superseded"/u);
  const adminJobs = readFileSync("src/app/admin/(protected)/jobs/page.tsx", "utf8");
  assert.match(adminJobs, /job\.status === "failed" \|\| job\.status === "superseded"/u);
});
test("reader page binds exercise answers to the first exercise section only", () => {
  const src = readFileSync("src/app/courses/[id]/chapters/[chapterId]/page.tsx", "utf8");
  assert.match(src, /firstExerciseSectionIndex = sections\.findIndex/u);
  assert.match(src, /index === firstExerciseSectionIndex/u);
});

