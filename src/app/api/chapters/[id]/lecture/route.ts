import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { shouldRunInlineGeneration } from "@/lib/config";
import { runLectureGenerationJob } from "@/lib/generationRunner";
import { createGenerationJob } from "@/lib/jobs";
import { parseModelOverridesFromHeaders } from "@/lib/modelOverrides";
import { publicGenerationJob } from "@/lib/publicGenerationJob";
import { getActiveServerGenerationJobForChapter, getActiveServerGenerationJobForChapterOfType, getServerCourse, saveServerGenerationJob, updateServerChapter } from "@/lib/serverStore";
import { resolveModelOverrides } from "@/lib/userModelConfig";
import { Course, GenerationJob } from "@/lib/types";

/**
 * On-demand lecture (讲义) generation for a textbook chapter. One job per
 * chapter at a time; a ready lecture is returned immediately. Charged against
 * the generate_lecture quota inside the runner.
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
  if (course.contentMode !== "textbook") {
    return NextResponse.json({ error: "讲义模式仅适用于教材模式课程。" }, { status: 400 });
  }

  const chapter = course.chapters.find((item) => item.id === id);
  if (!chapter) {
    return NextResponse.json({ error: "Chapter not found" }, { status: 404 });
  }
  if (!chapter.content && !chapter.sections?.length) {
    return NextResponse.json({ error: "本章正文尚未生成，暂无法生成讲义。" }, { status: 409 });
  }

  if (chapter.lecture?.status === "ready" && !input.retry) {
    return NextResponse.json({ course, lecture: chapter.lecture, ready: true });
  }

  // A chapter regeneration in flight owns the chapter; a lecture generated now
  // would condense a moving target.
  const activeChapterJob = await getActiveServerGenerationJobForChapter(chapter.id, request);
  if (activeChapterJob) {
    return NextResponse.json(
      {
        error: "本章正文正在重新生成，请等待章节任务完成后再生成讲义。",
        course,
        job: publicGenerationJob(activeChapterJob),
        retryBlocked: true,
      },
      { status: 409 },
    );
  }

  const activeLectureJob = await getActiveServerGenerationJobForChapterOfType(chapter.id, "lecture", request);
  if (activeLectureJob) {
    if (input.retry) {
      return retryBlockedResponse(course, activeLectureJob);
    }
    const updatedCourse = chapter.lecture
      ? course
      : await updateServerChapter(course, id, { lecture: { status: "queued" } }, request);
    return NextResponse.json(
      {
        course: updatedCourse,
        job: publicGenerationJob(activeLectureJob),
        queued: true,
      },
      { status: 202 },
    );
  }

  const userId = auth.userId;
  const headerOverrides = parseModelOverridesFromHeaders(request.headers);
  const overrides = await resolveModelOverrides(userId, headerOverrides);

  const job = createGenerationJob({
    type: "lecture",
    courseId: course.id,
    chapterId: chapter.id,
    userId,
    activeAgent: "AUTHOR",
    status: "queued",
    modelOverrides: overrides,
    message: "讲义生成已排队。",
  });
  const persistedJob = await saveServerGenerationJob(job, request);
  const updatedCourse = await updateServerChapter(course, id, {
    lecture: { status: "queued" },
  }, request);

  if (shouldRunInlineGeneration(request)) {
    scheduleLectureGeneration(request, persistedJob.id);
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
      error: "当前章节已有讲义生成任务，请等待任务完成后再重新生成。",
      course,
      job: publicGenerationJob(job),
      queued: true,
      retryBlocked: true,
    },
    { status: 409 },
  );
}

function scheduleLectureGeneration(request: Request, jobId: string) {
  const runnerRequest = new Request(request.url, {
    headers: new Headers(request.headers),
  });

  void runLectureGenerationJob({
    jobId,
    request: runnerRequest,
  }).catch((error: unknown) => {
    console.error("Background lecture generation failed", error);
  });
}
