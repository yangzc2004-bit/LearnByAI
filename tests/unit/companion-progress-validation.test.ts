import assert from "node:assert/strict";
import test from "node:test";
import { validateQuizSubmission } from "../../src/lib/companionProgressValidation";

test("accepts completion-only submissions", () => {
  assert.deepEqual(validateQuizSubmission({ questionCount: 4 }), { ok: true });
});

test("accepts a score within the current question count", () => {
  assert.deepEqual(validateQuizSubmission({ questionCount: 4, quizScore: 3, quizTotal: 4 }), { ok: true });
});

test("rejects when the chapter has no quiz", () => {
  const result = validateQuizSubmission({ questionCount: 0, quizScore: 1, quizTotal: 1 });
  assert.equal(result.ok, false);
});

test("rejects a total that does not match the current question count", () => {
  const result = validateQuizSubmission({ questionCount: 4, quizScore: 2, quizTotal: 3 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /4/);
});

test("rejects a score above the total", () => {
  const result = validateQuizSubmission({ questionCount: 4, quizScore: 5, quizTotal: 4 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /quizScore/);
});

test("rejects a score above the existing total when total is omitted", () => {
  const result = validateQuizSubmission({ questionCount: 4, quizScore: 4, existingQuizTotal: 3 });
  assert.equal(result.ok, false);
});
