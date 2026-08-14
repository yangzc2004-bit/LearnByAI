/**
 * Quiz-score submission validation for companion-guide progress (AI 伴学
 * 计划 P0): the score must never exceed the total, and the total must equal
 * the current quiz question count. Pure module so API behavior is unit-
 * testable.
 */
export type QuizSubmissionValidation = {
  ok: true;
} | {
  ok: false;
  error: string;
};

export function validateQuizSubmission(input: {
  questionCount: number;
  quizScore?: number;
  quizTotal?: number;
  existingQuizTotal?: number;
}): QuizSubmissionValidation {
  const { questionCount, quizScore, quizTotal, existingQuizTotal } = input;
  if (quizScore === undefined && quizTotal === undefined) return { ok: true };

  if (questionCount === 0) {
    return { ok: false, error: "当前章节还没有小测，无法提交成绩。" };
  }
  const effectiveTotal = quizTotal ?? existingQuizTotal;
  if (effectiveTotal === undefined) {
    return { ok: false, error: "缺少 quizTotal，无法校验成绩。" };
  }
  if (quizTotal !== undefined && quizTotal !== questionCount) {
    return { ok: false, error: `quizTotal 必须等于当前小测题数（${questionCount}）。` };
  }
  if (quizScore !== undefined && quizScore > effectiveTotal) {
    return { ok: false, error: "quizScore 不能大于 quizTotal。" };
  }
  return { ok: true };
}
