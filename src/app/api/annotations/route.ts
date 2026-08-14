import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/apiAuth";
import { askTutor } from "@/lib/maol/client";
import { parseModelOverridesFromHeaders } from "@/lib/modelOverrides";
import { withQuotaConsumption } from "@/lib/quota";
import { safeErrorMessage } from "@/lib/safeError";
import { deleteServerAnnotation, getServerCourse, getServerLectureProgress, listServerAnnotations, saveServerAnnotation, saveServerGenerationJob } from "@/lib/serverStore";
import { encodeSseEvent } from "@/lib/sse";
import { resolveModelOverrides } from "@/lib/userModelConfig";
import { stripCitationMarkers } from "@/lib/citations";
import { Annotation, Chapter, Course, Section } from "@/lib/types";

const TUTOR_ROUTE_TIMEOUT_MS = 125_000;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const { searchParams } = new URL(request.url);
  const chapterId = searchParams.get("chapterId") ?? undefined;
  const courseId = searchParams.get("courseId") ?? undefined;
  if (!chapterId && !courseId) {
    return NextResponse.json({ error: "chapterId or courseId is required" }, { status: 400 });
  }

  return NextResponse.json({
    annotations: await listServerAnnotations({ chapterId, courseId }, request),
  });
}

export async function DELETE(request: Request) {
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  await deleteServerAnnotation(id, request);
  return NextResponse.json({ deleted: true });
}

export async function POST(request: Request) {
  const input = await request.json();
  const auth = await requireApiUser(request);
  if ("response" in auth) return auth.response;

  const anchor = await validateAnnotationAnchor(input.annotation, request);
  if ("response" in anchor) return anchor.response;

  const course = anchor.course ?? await resolveTutorCourse(input, request);
  const chapter = resolveTutorChapter(course, anchor.annotation);

  const userId = auth.userId;
  const headerOverrides = parseModelOverridesFromHeaders(request.headers);
  const overrides = await resolveModelOverrides(userId, headerOverrides);

  if (input.stream) {
    return handleStreamingPost({ input, userId, overrides, course, chapter, anchor, request });
  }

  try {
    const result = await withDeadline(withQuotaConsumption(userId, "ask_tutor", async () => {
      const response = await askTutor({
        topic: input.topic,
        selectedText: input.selectedText,
        question: input.question,
        history: input.history ?? [],
        context: await buildTutorContext(course, chapter, anchor.annotation, input.question as string | undefined, input.selectedText as string | undefined, request),
        overrides,
        onJobUpdate: async (updatedJob) => {
          await saveServerGenerationJob(updatedJob, request);
        },
      });
      if (response.job) {
        await saveServerGenerationJob(response.job, request);
      }

      let annotation: Annotation | undefined;
      const clientAnnotation = stripClientOnlyMessages(anchor.annotation);
      if (clientAnnotation) {
        const now = new Date().toISOString();
        annotation = clientAnnotation;
        annotation.messages = [
          ...annotation.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: stripCitationMarkers(response.answer),
          },
        ];
        annotation.createdAt = annotation.createdAt ?? now;
        annotation = await saveServerAnnotation(withDerivedTitleSummary(annotation), request);
      }

      return { ...response, annotation };
    }), TUTOR_ROUTE_TIMEOUT_MS);
    if (!result.ok) {
      return NextResponse.json({ error: result.quota.message }, { status: 429 });
    }

    return NextResponse.json(result.value);
  } catch (error) {
    const message = tutorErrorMessage(error);
    await persistFailedAnnotation(anchor.annotation, message, request);
    return NextResponse.json(
      { error: message },
      { status: 502 },
    );
  }
}

async function handleStreamingPost(params: {
  input: Record<string, unknown>;
  userId: string;
  overrides: ReturnType<typeof parseModelOverridesFromHeaders>;
  course: Course | undefined;
  chapter: Chapter | undefined;
  anchor: { annotation?: Annotation };
  request: Request;
}) {
  const { input, userId, overrides, course, chapter, anchor, request } = params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event: string, data: string) => {
        controller.enqueue(encoder.encode(encodeSseEvent(event, data)));
      };

      try {
        const result = await withDeadline(withQuotaConsumption(userId, "ask_tutor", async () => {
          let fullAnswer = "";
          let hasChunks = false;
          const response = await askTutor({
            topic: input.topic as string,
            selectedText: input.selectedText as string,
            question: input.question as string,
            history: (input.history as { role: "user" | "assistant"; content: string }[]) ?? [],
            context: await buildTutorContext(course, chapter, anchor.annotation, input.question as string | undefined, input.selectedText as string | undefined, request),
            overrides,
            onChunk: (chunk) => {
              hasChunks = true;
              fullAnswer += chunk;
              enqueue("token", JSON.stringify({ text: chunk }));
            },
            onJobUpdate: async (updatedJob) => {
              await saveServerGenerationJob(updatedJob, request);
            },
          });

          // Fallback: mock mode doesn't fire onChunk — use the full response
          if (!hasChunks && response.answer) {
            fullAnswer = response.answer;
            enqueue("token", JSON.stringify({ text: response.answer }));
          }

          if (response.job) {
            await saveServerGenerationJob(response.job, request);
          }

          let savedAnnotation: Annotation | undefined;
          const clientAnnotation = stripClientOnlyMessages(anchor.annotation);
          if (clientAnnotation) {
            const now = new Date().toISOString();
            const annotation = clientAnnotation;
            annotation.messages = [
              ...annotation.messages,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: stripCitationMarkers(fullAnswer),
              },
            ];
            annotation.createdAt = annotation.createdAt ?? now;
            savedAnnotation = await saveServerAnnotation(withDerivedTitleSummary(annotation), request);
          }

          return { fullAnswer, savedAnnotation };
        }), TUTOR_ROUTE_TIMEOUT_MS);

        if (!result.ok) {
          enqueue("error", JSON.stringify({ error: result.quota.message }));
        } else {
          enqueue("done", JSON.stringify({
            answer: result.value.fullAnswer,
            annotation: result.value.savedAnnotation ?? null,
          }));
        }
      } catch (error) {
        const message = tutorErrorMessage(error);
        await persistFailedAnnotation(anchor.annotation, message, request);
        enqueue("error", JSON.stringify({ error: message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function stripClientOnlyMessages(annotation: Annotation | undefined) {
  if (!annotation) return undefined;
  return {
    ...annotation,
    messages: annotation.messages.filter((message) => message.role !== "assistant" || message.content.trim()),
  };
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Tutor request timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function tutorErrorMessage(error: unknown) {
  const message = safeErrorMessage(error, "Tutor answer failed.");
  if (/timed out|timeout|aborted/i.test(message)) {
    return "导师回答超时，请稍后重试。";
  }
  if (/401|unauthorized|api key|authentication/i.test(message)) {
    return "AI 服务鉴权失败，请联系管理员检查模型配置。";
  }
  return "导师暂时无法回答，请稍后重试。";
}

async function resolveTutorCourse(
  input: Record<string, unknown>,
  request: Request,
) {
  const courseId = input.courseId as string | undefined;
  if (!courseId) return undefined;
  return getServerCourse(courseId, request);
}

function resolveTutorChapter(
  course: Course | undefined,
  annotation?: Annotation,
) {
  if (!course) return undefined;
  const chapterId = annotation?.chapterId;
  if (!chapterId) return undefined;
  return course.chapters.find((ch) => ch.id === chapterId);
}

function previousChapter(course: Course | undefined, chapter: Chapter | undefined) {
  if (!course || !chapter) return undefined;
  const idx = course.chapters.findIndex((ch) => ch.id === chapter.id);
  return idx > 0 ? course.chapters[idx - 1] : undefined;
}

function nextChapter(course: Course | undefined, chapter: Chapter | undefined) {
  if (!course || !chapter) return undefined;
  const idx = course.chapters.findIndex((ch) => ch.id === chapter.id);
  return idx >= 0 && idx < course.chapters.length - 1 ? course.chapters[idx + 1] : undefined;
}

function orderedSections(chapter: Chapter | undefined): Section[] {
  return [...(chapter?.sections ?? [])].sort((a, b) => a.order - b.order);
}

/**
 * Grounded tutor context: injects the chapter's actual content (layered) plus a
 * section map that doubles as the citation §index. The previously mislabeled
 * `summaryForNext` is now surfaced only as `bridgeToNext`; `chapterSummary` is
 * derived from the chapter itself, never from the next-chapter handoff note.
 */
async function buildTutorContext(
  course: Course | undefined,
  chapter: Chapter | undefined,
  annotation: Annotation | undefined,
  question: string | undefined,
  selectedText: string | undefined,
  request?: Request,
) {
  if (!course) return undefined;

  const sections = orderedSections(chapter);
  const sectionMap = sections.map((section, index) => ({
    label: `§${index + 1}`,
    title: section.title,
    purpose: section.purpose,
  }));
  const anchoredSection = annotation?.sectionId
    ? sections.find((section) => section.id === annotation.sectionId)
    : undefined;
  // 伴学上下文（AI 伴学指南计划 P1）：让导师知道用户当前跟学的伴学目标、
  // 完成状态与最近小测结果，回答可以围绕这些目标展开。
  const progress = chapter && request ? await getServerLectureProgress(chapter.id, request) : undefined;
  const companionGuide = chapter?.companionGuide;

  return {
    goal: course.goal,
    learnerProfile: course.profile,
    teachingStyle: course.courseBible?.teachingStyle,
    styles: course.styles,
    learningMode: course.learningMode,
    chapterTitle: chapter?.title,
    chapterDescription: chapter?.description,
    chapterPurpose: chapter?.purpose,
    previousChapterTitle: previousChapter(course, chapter)?.title,
    nextChapterTitle: nextChapter(course, chapter)?.title,
    chapterSummary: deriveChapterSummary(chapter, sections),
    bridgeToNext: chapter?.contract?.summaryForNext,
    sectionMap,
    sectionContent: anchoredSection ? truncateChars(anchoredSection.content, 4000) : undefined,
    chapterContent: process.env.TUTOR_FULL_CHAPTER_CONTEXT === "true"
      ? truncateChars(chapterContentText(chapter, sections), 30000)
      : undefined,
    terminology: selectRelevantTerminology(course.courseBible?.terminology, question ?? "", selectedText ?? ""),
    companion: companionGuide
      ? {
          learningObjectives: companionGuide.learningObjectives?.slice(0, 4),
          completed: progress?.completed,
          latestQuiz: progress?.quizScore !== undefined && progress?.quizTotal !== undefined
            ? { score: progress.quizScore, total: progress.quizTotal }
            : null,
        }
      : undefined,
  };
}

/** Inject only terminology terms the question actually touches (max 8). */
function selectRelevantTerminology(
  terminology: { term: string; definition: string }[] | undefined,
  question: string,
  selectedText: string,
) {
  if (!terminology?.length) return undefined;
  const haystack = `${question} ${selectedText}`.toLowerCase();
  const matched = terminology
    .filter((entry) => entry.term.length >= 2 && haystack.includes(entry.term.toLowerCase()))
    .slice(0, 8);
  return matched.length ? matched : undefined;
}

function deriveChapterSummary(chapter: Chapter | undefined, sections: Section[]): string | undefined {
  if (!chapter) return undefined;
  const parts: string[] = [];
  if (chapter.description) parts.push(chapter.description);
  if (sections.length) {
    parts.push(`本章分 ${sections.length} 节：${sections.map((s, i) => `§${i + 1} ${s.title}`).join("、")}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function chapterContentText(chapter: Chapter | undefined, sections: Section[]): string {
  if (chapter?.content) return chapter.content;
  return sections.map((section) => `## ${section.title}\n${section.content}`).join("\n\n");
}

function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[内容过长，已截断]`;
}

/** Deterministic title/summary for the history list — no extra LLM call. */
function withDerivedTitleSummary(annotation: Annotation): Annotation {
  const title = annotation.title?.trim() || truncateText(annotation.question, 30);
  const summary = annotation.summary?.trim() || firstParagraph(lastAssistantContent(annotation));
  return { ...annotation, title, ...(summary ? { summary } : {}) };
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function lastAssistantContent(annotation: Annotation): string {
  const last = [...annotation.messages].reverse().find((message) => message.role === "assistant");
  return last?.content?.trim() ?? "";
}

function firstParagraph(text: string): string {
  const paragraph = text.split(/\n\s*\n/)[0] ?? "";
  return truncateText(paragraph.trim(), 80);
}

/** Persist a failed question so the thread survives a refresh and can be retried. */
async function persistFailedAnnotation(
  annotation: Annotation | undefined,
  errorMessage: string,
  request: Request,
) {
  if (!annotation) return;
  const failed: Annotation = {
    ...annotation,
    messages: [
      ...stripClientOnlyMessages(annotation)!.messages,
      { id: crypto.randomUUID(), role: "assistant", content: `⚠️ ${errorMessage}` },
    ],
  };
  await saveServerAnnotation(withDerivedTitleSummary(failed), request).catch(() => undefined);
}

async function validateAnnotationAnchor(annotationInput: unknown, request: Request) {
  if (!annotationInput) return {};

  const annotation = annotationInput as Annotation;
  if (!annotation.courseId) {
    return { response: NextResponse.json({ error: "Annotation courseId is required" }, { status: 400 }) };
  }

  const course = await getServerCourse(annotation.courseId, request);
  if (!course) {
    return { response: NextResponse.json({ error: "Course not found" }, { status: 404 }) };
  }

  if (!courseHasChapter(course, annotation.chapterId)) {
    return { response: NextResponse.json({ error: "Chapter not found" }, { status: 404 }) };
  }

  if (annotation.sectionId && !courseHasSection(course, annotation.chapterId, annotation.sectionId)) {
    return { response: NextResponse.json({ error: "Section not found" }, { status: 404 }) };
  }

  return { annotation, course };
}

function courseHasChapter(course: Course, chapterId: string) {
  return course.chapters.some((chapter) => chapter.id === chapterId);
}

function courseHasSection(course: Course, chapterId: string, sectionId: string) {
  return course.chapters
    .find((chapter) => chapter.id === chapterId)
    ?.sections?.some((section) => section.id === sectionId) ?? false;
}
