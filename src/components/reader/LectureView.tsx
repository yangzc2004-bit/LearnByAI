"use client";

import { useMemo, useState } from "react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { ChapterLecture, LectureProgress, Section } from "@/lib/types";
import { BookOpen, CheckCircle2, ChevronRight, Lightbulb, RotateCcw, Target } from "lucide-react";

type LectureViewProps = {
  lecture: ChapterLecture;
  chapterNumber: number;
  sections: Section[];
  progress: LectureProgress | null | undefined;
  onSaveProgress: (score: number, total: number) => Promise<void>;
  onJumpToSection: (sectionId: string) => void;
};

/**
 * The lecture (讲义) reader: a continuous, document-style lecture-note view —
 * learning objectives, a flowing sequence of teach sections (intuition →
 * definition/concept box → worked example box, each anchored back to its
 * textbook section), a recap, a next-lecture preview, then inline self-checks
 * and a final quiz with scoring + check-in. Every text field renders through
 * the KaTeX pipeline so $...$ math is typeset, never shown as raw source.
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
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [localProgress, setLocalProgress] = useState(progress);
  const [latestScore, setLatestScore] = useState<{ score: number; total: number } | undefined>(
    progress?.quizScore !== undefined && progress?.quizTotal !== undefined
      ? { score: progress.quizScore, total: progress.quizTotal }
      : undefined,
  );

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

  const teachBlocks = blocks.filter((block): block is Extract<(typeof blocks)[number], { kind: "teach" }> => block.kind === "teach");

  function jumpToAnchor(anchorSection: string) {
    const sectionId = anchorMap.get(anchorSection);
    if (sectionId) onJumpToSection(sectionId);
  }

  async function submitQuiz() {
    if (quiz.length === 0 || submitted) return;
    setSubmitted(true);
    setSaving(true);
    setSaveError(null);
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
    } catch (error) {
      // 保存失败：恢复提交按钮、显示错误并允许直接重试。
      setSubmitted(false);
      setSaveError(error instanceof Error && error.message ? error.message : "小测成绩保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }
  }

  function resetQuiz() {
    setSubmitted(false);
    setQuizAnswers({});
    setSaveError(null);
  }

  return (
    <div className="space-y-2">
      {/* Completion line — small, so the document stays a document. */}
      {localProgress?.completed && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={13} />
          本讲已完成打卡
          {latestScore && <span className="font-mono">最近小测 {latestScore.score}/{latestScore.total}</span>}
          {localProgress.bestScore !== undefined && localProgress.bestScore > 0 && (
            <span className="font-mono">历史最佳 {localProgress.bestScore}</span>
          )}
        </p>
      )}

      {/* Learning objectives */}
      {(lecture.learningObjectives?.length ?? 0) > 0 && (
        <section className="my-6 rounded-lg border border-border bg-muted/20 px-5 py-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Target size={15} className="text-primary" />
            本讲目标
          </h2>
          <ul className="space-y-1.5">
            {lecture.learningObjectives!.map((objective, index) => (
              <li key={index} className="flex items-start gap-2 text-sm leading-relaxed">
                <span className="mt-0.5 font-mono text-xs text-primary">{index + 1}.</span>
                <MarkdownContent content={objective} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Continuous document flow */}
      <article className="space-y-6">
        {blocks.map((block, index) => {
          if (block.kind === "review") {
            return (
              <section key={index}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">回顾</p>
                <MarkdownContent content={block.text} variant="textbook" />
              </section>
            );
          }
          if (block.kind === "teach") {
            const sectionId = block.anchorSection ? anchorMap.get(block.anchorSection) : undefined;
            const teachIndex = teachBlocks.findIndex((item) => item === block) + 1;
            const heading = block.anchorSection
              ? `${block.anchorSection} ${block.title}`
              : `${teachIndex} ${block.title}`;
            return (
              <section key={index} className="border-t border-border/60 pt-5">
                <h2 className="mb-4 text-lg font-semibold tracking-tight text-foreground">
                  {heading}
                </h2>
                <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                  <Lightbulb size={13} /> 直觉
                </div>
                <MarkdownContent content={block.intuition} variant="textbook" />

                <div className="mb-3 mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                  <BookOpen size={13} /> 核心概念
                </div>
                <div className="mb-5 rounded-r-lg border-l-2 border-primary bg-muted/30 py-1 pl-4">
                  <MarkdownContent content={block.concept} variant="textbook" />
                </div>

                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">例题</div>
                <div className="rounded-r-lg border-l-2 border-amber-500/60 bg-amber-500/5 py-1 pl-4">
                  <MarkdownContent content={block.example} variant="textbook" />
                </div>

                {block.anchorSection && sectionId && (
                  <button
                    type="button"
                    onClick={() => jumpToAnchor(block.anchorSection!)}
                    className="mt-4 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    回教材第 {block.anchorSection} 节看原文 <ChevronRight size={13} />
                  </button>
                )}
              </section>
            );
          }
          if (block.kind === "recap") {
            return (
              <section key={index} className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-5 py-4">
                <h2 className="mb-2 text-sm font-semibold text-amber-700 dark:text-amber-300">小结：记住这 3 件事</h2>
                <ul className="space-y-1.5">
                  {block.points.map((point, pointIndex) => (
                    <li key={pointIndex} className="flex items-start gap-2 text-sm leading-relaxed">
                      <span className="mt-0.5 font-mono text-xs text-amber-600 dark:text-amber-400">{pointIndex + 1}.</span>
                      <MarkdownContent content={point} variant="textbook" />
                    </li>
                  ))}
                </ul>
              </section>
            );
          }
          return (
            <section key={index} className="border-t border-border/60 pt-5">
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">下讲预告</h2>
              <MarkdownContent content={block.text} variant="textbook" />
            </section>
          );
        })}
      </article>

      {/* Self-check — inline questions with foldable answers */}
      {(lecture.selfCheck?.length ?? 0) > 0 && (
        <section className="mt-8 border-t border-border pt-6">
          <h2 className="mb-3 text-base font-semibold text-foreground">随堂自测</h2>
          <p className="mb-3 text-xs text-muted-foreground">先自己想，再点开答案。</p>
          <div className="space-y-3">
            {lecture.selfCheck!.map((item, index) => (
              <SelfCheckItem key={index} index={index} question={item.question} answer={item.answer} />
            ))}
          </div>
        </section>
      )}

      {/* Final quiz */}
      {quiz.length > 0 && (
        <section className="mt-8 border-t border-border pt-6">
          <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-foreground">
            <Target size={15} className="text-primary" />
            本讲小测
          </h2>
          <p className="mb-4 text-xs text-muted-foreground">共 {quiz.length} 题 · 提交后显示得分并自动打卡。</p>
          <div className="space-y-6">
            {quiz.map((question, questionIndex) => {
              const answered = quizAnswers[questionIndex];
              const isCorrect = submitted && answered === question.correctIndex;
              const isWrong = submitted && answered !== undefined && answered !== question.correctIndex;
              return (
                <div key={questionIndex} className="space-y-2">
                  <div className="flex items-start gap-2 text-sm font-medium text-foreground">
                    <span className="mt-0.5 font-mono text-xs text-muted-foreground">{questionIndex + 1}.</span>
                    <MarkdownContent content={question.question} variant="textbook" />
                  </div>
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
                          <MarkdownContent content={option} variant="textbook" />
                        </button>
                      );
                    })}
                  </div>
                  {submitted && (
                    <div className={`pl-5 text-xs leading-relaxed ${isCorrect ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                      {isCorrect ? "回答正确。" : isWrong ? "回答错误。" : "未作答。"}
                      <MarkdownContent content={question.explanation} variant="textbook" />
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
            <div className="mt-6">
              {saveError && (
                <p className="mb-3 text-xs text-destructive">{saveError}</p>
              )}
              <button
                type="button"
                onClick={() => void submitQuiz()}
                disabled={quiz.some((_, index) => quizAnswers[index] === undefined)}
                className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                提交小测
              </button>
            </div>
          )}
      )}
    </div>
  );
}

function SelfCheckItem({ index, question, answer }: { index: number; question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-start gap-2 text-sm text-foreground">
        <span className="mt-0.5 font-mono text-xs text-primary">{index + 1}.</span>
        <MarkdownContent content={question} variant="textbook" />
      </div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="mt-2 text-xs text-primary hover:underline"
      >
        {open ? "收起答案" : "显示答案"}
      </button>
      {open && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <MarkdownContent content={answer} variant="textbook" />
        </div>
      )}
    </div>
  );
}
