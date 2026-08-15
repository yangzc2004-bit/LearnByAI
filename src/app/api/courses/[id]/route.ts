import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { shouldRunInlineGeneration } from "@/lib/config";
import { runChapterGenerationJob } from "@/lib/generationRunner";
import { createGenerationJob } from "@/lib/jobs";
import { parseModelOverridesFromHeaders } from "@/lib/modelOverrides";
import { publicGenerationJob } from "@/lib/publicGenerationJob";
import { CourseUpdateConflictError, deleteServerCourse, getActiveServerGenerationJobForChapter, getServerCourse, saveServerCourse, saveServerGenerationJob, updateServerChapter } from "@/lib/serverStore";
import { resolveModelOverrides } from "@/lib/userModelConfig";
import { Chapter, Course, FigureMode, GenerationJob } from "@/lib/types";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const course = await getServerCourse(id, request);

  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const { course: hydratedCourse, jobs } = await enqueueDraftReviewJobs(course, request, auth.userId);

  return NextResponse.json({ course: hydratedCourse, jobs: jobs.map(publicGenerationJob) });
}

/** Course-level settings (currently the figure policy). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const course = await getServerCourse(id, request);
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { figureMode?: unknown };
  if (body.figureMode !== undefined) {
    if (!["model", "code", "off"].includes(String(body.figureMode))) {
      return NextResponse.json({ error: "figureMode must be model | code | off" }, { status: 400 });
    }
    try {
      const updated = await saveServerCourse({
        ...course,
        figureMode: body.figureMode as FigureMode,
        updatedAt: new Date().toISOString(),
      }, request);
      return NextResponse.json({ course: updated });
    } catch (error) {
      if (error instanceof CourseUpdateConflictError) {
        return NextResponse.json(
          { error: "课程已被其他操作更新，请刷新页面后重试。" },
          { status: 409 },
        );
      }
      throw error;
    }
  }

  return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const deleted = await deleteServerCourse(id, request);
  if (!deleted) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

async function enqueueDraftReviewJobs(course: Course, request: Request, userId: string) {
  let nextCourse = course;
  const jobs: GenerationJob[] = [];
  const headerOverrides = parseModelOverridesFromHeaders(request.headers);
  const modelOverrides = await resolveModelOverrides(userId, headerOverrides);

  for (const chapter of course.chapters) {
    if (!needsDraftReview(chapter)) continue;

    const activeJob = await getActiveServerGenerationJobForChapter(chapter.id, request);
    if (activeJob) {
      jobs.push(activeJob);
      continue;
    }

    const job = createGenerationJob({
      type: "chapter",
      mode: "review_draft",
      courseId: course.id,
      chapterId: chapter.id,
      userId,
      activeAgent: "POLISHER",
      status: "queued",
      modelOverrides,
      message: "Draft queued for quality review.",
    });
    const persistedJob = await saveServerGenerationJob(job, request);
    jobs.push(persistedJob);
    nextCourse = await updateServerChapter(
      nextCourse,
      chapter.id,
      {
        status: "draft_ready",
        generationJobId: persistedJob.id,
      },
      request,
    );

    if (shouldRunInlineGeneration(request)) {
      scheduleDraftReview(request, persistedJob.id);
    }
  }

  return { course: nextCourse, jobs };
}

function needsDraftReview(chapter: Chapter) {
  if (chapter.qualityReport) return false;
  if (!chapter.content && !chapter.sections?.length) return false;
  const status = chapter.status ?? "pending";
  return status === "draft_ready" || status === "generating" || status === "queued";
}

function scheduleDraftReview(request: Request, jobId: string) {
  const runnerRequest = new Request(request.url, {
    headers: new Headers(request.headers),
  });

  void runChapterGenerationJob({
    jobId,
    request: runnerRequest,
  }).catch((error: unknown) => {
    console.error("Background draft quality review failed", error);
  });
}
