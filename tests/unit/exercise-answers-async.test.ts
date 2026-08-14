import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("chapter generation no longer awaits exercise answers inline", () => {
  const src = readFileSync("src/lib/maol/client.ts", "utf8");
  // Both the full pipeline and the draft-review pipeline must return the
  // chapter WITHOUT waiting on the answer provider.
  assert.doesNotMatch(src, /await generateExerciseAnswers/u);
  assert.match(src, /export async function generateExerciseAnswers/u);
});

test("generation runner queues answers as a separate background job after ready", () => {
  const src = readFileSync("src/lib/generationRunner.ts", "utf8");
  assert.match(src, /type: "exercise-answers"/u);
  assert.match(src, /message: "练习详解已排队，将在后台生成，不影响章节阅读。"/u);
  assert.match(src, /export async function runExerciseAnswersGenerationJob/u);
  // The background runner only ever writes exerciseAnswers — chapter status
  // is untouched by the answer pass.
  assert.ok(src.includes("{ exerciseAnswers: answers }"), "runner must only write exerciseAnswers");
});

test("generation worker dispatches exercise-answers jobs", () => {
  const src = readFileSync("src/lib/generationWorker.ts", "utf8");
  assert.match(src, /claimed\.type === "exercise-answers"/u);
});

test("reader page binds exercise answers to the first exercise section only", () => {
  const src = readFileSync("src/app/courses/[id]/chapters/[chapterId]/page.tsx", "utf8");
  assert.match(src, /firstExerciseSectionIndex = sections\.findIndex/u);
  assert.match(src, /index === firstExerciseSectionIndex/u);
});

