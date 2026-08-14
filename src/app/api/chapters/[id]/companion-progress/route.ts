import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { getServerCourse, getServerLectureProgress, saveServerLectureProgress } from "@/lib/serverStore";
import { CompanionProgress } from "@/lib/types";
import { safeErrorMessage } from "@/lib/safeError";
import { validateQuizSubmission } from "@/lib/companionProgressValidation";

/**
 * Per-chapter companion-guide (AI 伴学指南) learning progress: completion
 * checkmark + latest and best final-quiz scores. Stored server-side keyed by
 * (user, chapter).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const courseId = new URL(request.url).searchParams.get("courseId");
  if (!courseId) {
    return NextResponse.json({ error: "courseId query parameter is required" }, { status: 400 });
  }
  const course = await getServerCourse(courseId, request);
  if (!course || !course.chapters.some((chapter) => chapter.id === id)) {
    return NextResponse.json({ error: "Course or chapter not found" }, { status: 404 });
  }

  const progress = await getServerLectureProgress(id, request);
  return NextResponse.json({ progress: progress ?? null });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    courseId?: string;
    completed?: boolean;
    quizScore?: number;
    quizTotal?: number;
  };
  if (!body.courseId) {
    return NextResponse.json({ error: "courseId is required" }, { status: 400 });
  }
  const course = await getServerCourse(body.courseId, request);
  if (!course || !course.chapters.some((chapter) => chapter.id === id)) {
    return NextResponse.json({ error: "Course or chapter not found" }, { status: 404 });
  }

  const chapter = course.chapters.find((item) => item.id === id);
  const questionCount = (chapter?.companionGuide?.finalQuiz ?? chapter?.lecture?.finalQuiz ?? []).length;

  const existing = await getServerLectureProgress(id, request);
  const quizScore = normalizeScore(body.quizScore);
  const quizTotal = normalizeScore(body.quizTotal);

  // 越界/一致性校验（伴学计划 P0）：分数不能超过题数，题数必须等于当前小测题数。
  const validation = validateQuizSubmission({
    questionCount,
    quizScore,
    quizTotal,
    existingQuizTotal: existing?.quizTotal,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const bestScore = Math.max(
    existing?.bestScore ?? 0,
    quizScore ?? 0,
  );

  const progress: CompanionProgress = {
    id: existing?.id ?? crypto.randomUUID(),
    userId: auth.userId,
    courseId: body.courseId,
    chapterId: id,
    completed: existing?.completed || body.completed === true,
    ...(quizScore !== undefined ? { quizScore } : existing?.quizScore !== undefined ? { quizScore: existing.quizScore } : {}),
    ...(quizTotal !== undefined ? { quizTotal } : existing?.quizTotal !== undefined ? { quizTotal: existing.quizTotal } : {}),
    bestScore,
    updatedAt: new Date().toISOString(),
  };

  try {
    const saved = await saveServerLectureProgress(progress, request);
    return NextResponse.json({ progress: saved });
  } catch (error) {
    // 保存失败必须显式返回错误，前端据此恢复按钮并允许重试。
    return NextResponse.json({ error: safeErrorMessage(error, "学习进度保存失败，请重试。") }, { status: 500 });
  }
}

function normalizeScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}
