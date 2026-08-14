import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { shouldRunInlineGeneration } from "@/lib/config";
import { runCompanionGuideGenerationJob } from "@/lib/generationRunner";
import { createGenerationJob } from "@/lib/jobs";
import { parseModelOverridesFromHeaders } from "@/lib/modelOverrides";
import { publicGenerationJob } from "@/lib/publicGenerationJob";
import { getActiveServerGenerationJobForChapter, getActiveServerGenerationJobForChapterOfType, getServerCourse, saveServerGenerationJob, updateServerChapter } from "@/lib/serverStore";
import { resolveModelOverrides } from "@/lib/userModelConfig";
import { Course, GenerationJob } from "@/lib/types";

/**
 * On-demand companion-guide (AI 伴学指南) generation for one chapter — works
 * for BOTH content modes (电子教材 and 电子讲义). One job per chapter at a
 * time; a ready guide is returned immediately. Charged against the
 * generate_companion quota inside the runner.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const input = (await request.json().catch(() => ({}))) as { courseId: string; retry?: boolean };
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const course = await getServerCourse(input.courseId, request);
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const chapter = course.chapters.find((item) => item.id === id);
  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }
  if (!chapter.content && !chapter.sections?.length) {
    return NextResponse.json({ error: "本章正文尚未生成，暂无法生成伴学指南。" }, { status: 409 });
  }

  if (chapter.companionGuide?.status === "ready" && !input.retry) {
    return NextResponse.json({ course, companionGuide: chapter.companionGuide, ready: true });
  }

  // A chapter regeneration in flight owns the chapter; a guide generated now
  // would condense a moving target.
  const activeChapterJob = await getActiveServerGenerationJobForChapter(chapter.id, request);
  if (activeChapterJob) {
    return NextResponse.json(
      {
        error: "本章正文正在重新生成，请等待章节任务完成后再生成伴学指南。",
        course,
        job: publicGenerationJob(activeChapterJob),
        retryBlocked: true,
      },
      { status: 409 },
    );
  }

  // Legacy compat: an old lecture-type job is still an active guide job.
  const activeCompanionJob =
    (await getActiveServerGenerationJobForChapterOfType(chapter.id, "companion-guide", request)) ??
    (await getActiveServerGenerationJobForChapterOfType(chapter.id, "lecture", request));
  if (activeCompanionJob) {
    if (input.retry) {
      return retryBlockedResponse(course, activeCompanionJob);
    }
    const updatedCourse = chapter.companionGuide
      ? course
      : await updateServerChapter(course, id, { companionGuide: { status: "queued" } }, request);
    return NextResponse.json(
      {
        course: updatedCourse,
        job: publicGenerationJob(activeCompanionJob),
        queued: true,
      },
      { status: 202 },
    );
  }

  const userId = auth.userId;
  const headerOverrides = parseModelOverridesFromHeaders(request.headers);
  const overrides = await resolveModelOverrides(userId, headerOverrides);

  const job = createGenerationJob({
    type: "companion-guide",
    courseId: course.id,
    chapterId: chapter.id,
    userId,
    activeAgent: "AUTHOR",
    status: "queued",
    modelOverrides: overrides,
    message: "伴学指南生成已排队。",
  });
  const persistedJob = await saveServerGenerationJob(job, request);
  const updatedCourse = await updateServerChapter(course, id, {
    companionGuide: { status: "queued" },
  }, request);

  if (shouldRunInlineGeneration(request)) {
    scheduleCompanionGeneration(request, persistedJob.id);
  }

  return NextResponse.json(
    {
      course: updatedCourse,
      job: publicGenerationJob(persistedJob),
      queued: true,
    },
    { status: 202 },
  );
}

function retryBlockedResponse(course: Course, job: GenerationJob) {
  return NextResponse.json(
    {
      error: "当前章节已有伴学指南生成任务，请等待任务完成后再重新生成。",
      course,
      job: publicGenerationJob(job),
      queued: true,
      retryBlocked: true,
    },
    { status: 409 },
  );
}

function scheduleCompanionGeneration(request: Request, jobId: string) {
  const runnerRequest = new Request(request.url, {
    headers: new Headers(request.headers),
  });

  void runCompanionGuideGenerationJob({
    jobId,
    request: runnerRequest,
  }).catch((error: unknown) => {
    console.error("Background companion-guide generation failed", error);
  });
}
