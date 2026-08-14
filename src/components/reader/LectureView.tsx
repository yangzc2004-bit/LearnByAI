"use client";

import { useMemo, useState } from "react";
import { ChapterLecture, LectureProgress, Section } from "@/lib/types";
import { BookOpen, CheckCircle2, ChevronDown, Lightbulb, ListChecks, RotateCcw, Sparkles, Target } from "lucide-react";

type LectureViewProps = {
  lecture: ChapterLecture;
  chapterNumber: number;
  sections: Section[];
  progress: LectureProgress | null | undefined;
  onSaveProgress: (score: number, total: number) => Promise<void>;
  onJumpToSection: (sectionId: string) => void;
};

/**
 * The interactive lecture (讲义) reader: objectives → progressive blocks
 * (review → teach → recap → preview) → inline self-checks → final quiz with
 * scoring and completion checkmark. Each teach block anchors back to its
 * textbook section.
 */
export function LectureView({
  lecture,
  chapterNumber,
  sections,
  progress,
  onSaveProgress,
  onJumpToSection,
}: LectureViewProps) {
  const blocks = lecture.blocks ?? [];
  const [revealedCount, setRevealedCount] = useState(() => (progress?.completed ? blocks.length : 1));
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localProgress, setLocalProgress] = useState(progress);
  const [latestScore, setLatestScore] = useState<{ score: number; total: number } | undefined>(
    progress?.quizScore !== undefined && progress?.quizTotal !== undefined
      ? { score: progress.quizScore, total: progress.quizTotal }
      : undefined,
  );

  const allRevealed = revealedCount >= blocks.length;
  const quiz = lecture.finalQuiz ?? [];
  const score = quiz.reduce((sum, question, index) => (
    sum + (quizAnswers[index] === question.correctIndex ? 1 : 0)
  ), 0);

  const anchorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const section of sections) {
      const match = section.content.match(/^##\s+(\d+(?:\.\d+)*)[\s、.．-]/mu);
      if (match?.[1] && !map.has(match[1])) {
        map.set(match[1], section.id);
      }
    }
    return map;
  }, [sections]);

  function jumpToAnchor(anchorSection: string) {
    const sectionId = anchorMap.get(anchorSection);
    if (sectionId) onJumpToSection(sectionId);
  }

  async function submitQuiz() {
    if (quiz.length === 0 || submitted) return;
    setSubmitted(true);
    setSaving(true);
    const total = quiz.length;
    try {
      await onSaveProgress(score, total);
      setLatestScore({ score, total });
      setLocalProgress((current) => ({
        ...(current ?? {
          id: crypto.randomUUID(),
          courseId: "",
          chapterId: "",
          updatedAt: new Date().toISOString(),
        }),
        completed: true,
        quizScore: score,
        quizTotal: total,
        bestScore: Math.max(current?.bestScore ?? 0, score),
        updatedAt: new Date().toISOString(),
      }));
    } finally {
      setSaving(false);
    }
  }

  function resetQuiz() {
    setSubmitted(false);
    setQuizAnswers({});
  }

  return (
    <div className="space-y-8">
      {/* Completion badge */}
      {localProgress?.completed && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
          <CheckCircle2 size={16} className="text-emerald-500" />
          <span className="text-emerald-700 dark:text-emerald-300">本讲已完成打卡</span>
          {latestScore && (
            <span className="font-mono text-xs text-muted-foreground">
              最近小测 {latestScore.score}/{latestScore.total}
            </span>
          )}
          {localProgress.bestScore !== undefined && localProgress.bestScore > 0 && (
            <span className="font-mono text-xs text-muted-foreground">
              历史最佳 {localProgress.bestScore}
            </span>
          )}
        </div>
      )}

      {/* Learning objectives */}
      {(lecture.learningObjectives?.length ?? 0) > 0 && (
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Target size={16} className="text-primary" />
            本讲目标
          </h2>
          <ul className="space-y-2">
            {lecture.learningObjectives!.map((objective, index) => (
              <li key={index} className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                <span className="mt-0.5 font-mono text-xs text-primary">{index + 1}.</span>
                <span>{objective}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Progressive blocks */}
      {blocks.slice(0, Math.min(revealedCount, blocks.length)).map((block, index) => {
        if (block.kind === "review") {
          return (
            <section key={index} className="rounded-lg border border-border bg-muted/20 p-5">
              <h2 className="mb-2 text-sm font-semibold text-foreground">上节回顾</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">{block.text}</p>
            </section>
          );
        }
        if (block.kind === "teach") {
          const sectionId = block.anchorSection ? anchorMap.get(block.anchorSection) : undefined;
          return (
            <section key={index} className="rounded-lg border border-border bg-card p-5">
              <h2 className="mb-4 text-lg font-semibold tracking-tight text-foreground">{block.title}</h2>
              <div className="space-y-4 text-sm leading-relaxed">
                <div>
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                    <Lightbulb size={13} /> 直觉切入
                  </h3>
                  <p className="text-muted-foreground">{block.intuition}</p>
                </div>
                <div>
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                    <BookOpen size={13} /> 核心概念
                  </h3>
                  <p className="text-foreground">{block.concept}</p>
                </div>
                <div>
                  <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                    <Sparkles size={13} /> 最小例子
                  </h3>
                  <p className="text-muted-foreground">{block.example}</p>
                </div>
              </div>
              {block.anchorSection && sectionId && (
                <button
                  type="button"
                  onClick={() => jumpToAnchor(block.anchorSection!)}
                  className="mt-4 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  回教材 {chapterNumber}.{block.anchorSection} 节看原文 →
                </button>
              )}
            </section>
          );
        }
        if (block.kind === "recap") {
          return (
            <section key={index} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
              <h2 className="mb-3 text-sm font-semibold text-amber-700 dark:text-amber-300">30 秒复盘：记住这 3 件事</h2>
              <ul className="space-y-2">
                {block.points.map((point, pointIndex) => (
                  <li key={pointIndex} className="flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                    <span className="mt-0.5 font-mono text-xs text-amber-600 dark:text-amber-400">{pointIndex + 1}.</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        }
        return (
          <section key={index} className="rounded-lg border border-border bg-muted/20 p-5">
            <h2 className="mb-2 text-sm font-semibold text-foreground">下讲预告</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{block.text}</p>
          </section>
        );
      })}

      {/* Continue button */}
      {!allRevealed && (
        <button
          type="button"
          onClick={() => setRevealedCount((count) => Math.min(blocks.length, count + 1))}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-3 text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <ChevronDown size={16} />
          继续下一块（{revealedCount}/{blocks.length}）
        </button>
      )}

      {/* Self-check */}
      {allRevealed && (lecture.selfCheck?.length ?? 0) > 0 && (
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <ListChecks size={16} className="text-primary" />
            随堂自测（先自己想，再点开答案）
          </h2>
          <div className="space-y-3">
            {lecture.selfCheck!.map((item, index) => (
              <details key={index} className="group rounded-md border border-border bg-background px-4 py-3">
                <summary className="cursor-pointer list-none text-sm text-foreground marker:hidden">
                  <span className="mr-2 font-mono text-xs text-primary">{index + 1}.</span>
                  {item.question}
                </summary>
                <p className="mt-2 border-t border-border/60 pt-2 text-sm leading-relaxed text-muted-foreground">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* Final quiz */}
      {allRevealed && quiz.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Target size={16} className="text-primary" />
            章末小测
          </h2>
          <p className="mb-4 text-xs text-muted-foreground">共 {quiz.length} 题 · 提交后显示得分并自动打卡。</p>
          <div className="space-y-6">
            {quiz.map((question, questionIndex) => {
              const answered = quizAnswers[questionIndex];
              const isCorrect = submitted && answered === question.correctIndex;
              const isWrong = submitted && answered !== undefined && answered !== question.correctIndex;
              return (
                <div key={questionIndex} className="space-y-2">
                  <p className="text-sm font-medium text-foreground">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">{questionIndex + 1}.</span>
                    {question.question}
                  </p>
                  <div className="space-y-1.5 pl-5">
                    {question.options.map((option, optionIndex) => {
                      const selected = answered === optionIndex;
                      const isCorrectOption = question.correctIndex === optionIndex;
                      return (
                        <button
                          key={optionIndex}
                          type="button"
                          disabled={submitted}
                          onClick={() => setQuizAnswers((current) => ({ ...current, [questionIndex]: optionIndex }))}
                          className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                            submitted
                              ? isCorrectOption
                                ? "border-emerald-500/50 bg-emerald-500/10 text-foreground"
                                : selected
                                  ? "border-destructive/50 bg-destructive/10 text-foreground"
                                  : "border-border text-muted-foreground"
                              : selected
                                ? "border-primary/60 bg-primary/10 text-foreground"
                                : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                          } disabled:cursor-default`}
                        >
                          <span className="mt-px font-mono text-xs">{String.fromCharCode(65 + optionIndex)}.</span>
                          <span>{option}</span>
                        </button>
                      );
                    })}
                  </div>
                  {submitted && (
                    <div className={`pl-5 text-xs leading-relaxed ${isCorrect ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                      {isCorrect ? "回答正确。" : isWrong ? "回答错误。" : "未作答。"}{" "}
                      {question.explanation}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {submitted ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <span className={`rounded-md border px-3 py-2 text-sm font-medium ${
                score === quiz.length
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}>
                得分：{score} / {quiz.length}{saving ? "（保存中…）" : ""}
              </span>
              {score < quiz.length && (
                <button
                  type="button"
                  onClick={resetQuiz}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw size={13} /> 再测一次
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void submitQuiz()}
              disabled={quiz.some((_, index) => quizAnswers[index] === undefined)}
              className="mt-6 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              提交小测
            </button>
          )}
        </section>
      )}
    </div>
  );
}
