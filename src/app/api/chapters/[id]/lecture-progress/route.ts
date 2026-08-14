import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { getServerCourse, getServerLectureProgress, saveServerLectureProgress } from "@/lib/serverStore";
import { LectureProgress } from "@/lib/types";

/**
 * Per-chapter lecture (讲义) learning progress: completion checkmark + latest
 * and best final-quiz scores. Stored server-side keyed by (user, chapter).
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

  const existing = await getServerLectureProgress(id, request);
  const quizScore = normalizeScore(body.quizScore);
  const quizTotal = normalizeScore(body.quizTotal);
  const bestScore = Math.max(
    existing?.bestScore ?? 0,
    quizScore ?? 0,
  );

  const progress: LectureProgress = {
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

  const saved = await saveServerLectureProgress(progress, request);
  return NextResponse.json({ progress: saved });
}

function normalizeScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : undefined;
}
