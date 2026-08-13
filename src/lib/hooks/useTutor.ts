"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/clientApi";
import { randomId } from "@/lib/clientId";
import { publicSafeErrorMessage } from "@/lib/publicSafeError";
import { createSseParser } from "@/lib/sse";
import { Annotation, Course } from "@/lib/types";

export const TUTOR_REQUEST_TIMEOUT_MS = 130_000;

export type TutorTarget =
  | { scope: "anchored"; selectedText: string; sectionId?: string }
  | { scope: "chapter" };

export function useTutor(course: Course | undefined, chapterId: string) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [active, setActive] = useState<Annotation>();
  const [target, setTarget] = useState<TutorTarget>();
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState("");
  const [historyScope, setHistoryScope] = useState<"chapter" | "course">("chapter");
  const controllerRef = useRef<AbortController | null>(null);

  // Switching chapters must never leak the previous chapter's conversation or
  // in-flight stream into the new chapter's panel.
  useEffect(() => {
    controllerRef.current?.abort();
    setActive(undefined);
    setTarget(undefined);
    setError("");
  }, [chapterId]);

  const reloadAnnotations = useCallback(() => {
    const scopeParam = historyScope === "course" && course?.id
      ? `courseId=${course.id}`
      : `chapterId=${chapterId}`;
    apiFetch(`/api/annotations?${scopeParam}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data) => {
        if (data?.annotations) setAnnotations(data.annotations);
      })
      .catch(() => undefined);
  }, [chapterId, historyScope, course]);

  // Refetch when the history scope toggles (skip the initial mount — the page
  // already triggers the first load on chapter navigation).
  const scopeInitialized = useRef(false);
  useEffect(() => {
    if (!scopeInitialized.current) {
      scopeInitialized.current = true;
      return;
    }
    reloadAnnotations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyScope]);

  const startAnchored = useCallback((selectedText: string, sectionId?: string) => {
    setTarget({ scope: "anchored", selectedText, sectionId });
    setActive(undefined);
    setError("");
  }, []);

  const startGeneral = useCallback(() => {
    setTarget({ scope: "chapter" });
    setActive(undefined);
    setError("");
  }, []);

  // Attach a newly selected passage to the CURRENT thread (keeping its history)
  // instead of discarding it for a brand-new conversation.
  const continueAnchored = useCallback((selectedText: string, sectionId?: string) => {
    setActive((current) => current
      ? { ...cloneAnnotation(current), selectedText, sectionId, scope: "anchored" }
      : current);
    setTarget({ scope: "anchored", selectedText, sectionId });
    setError("");
  }, []);

  const openThread = useCallback((annotation: Annotation) => {
    setActive(cloneAnnotation(annotation));
    setError("");
    setTarget(
      annotation.scope === "chapter" || !annotation.selectedText
        ? { scope: "chapter" }
        : { scope: "anchored", selectedText: annotation.selectedText, sectionId: annotation.sectionId },
    );
  }, []);

  const clear = useCallback(() => {
    setActive(undefined);
    setTarget(undefined);
    setError("");
  }, []);

  const streamAnswer = useCallback(
    async (annotation: Annotation, question: string) => {
      if (!course) return;
      setAnswering(true);
      const pendingId = randomId();
      let draft = appendMessage(annotation, { id: pendingId, role: "assistant", content: "" });
      setActive(draft);

      let saved: Annotation | undefined;
      const controller = new AbortController();
      controllerRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), TUTOR_REQUEST_TIMEOUT_MS);
      try {
        saved = await askTutorStreaming({
          topic: course.topic,
          selectedText: annotation.selectedText ?? "",
          question,
          // Exclude the just-appended user question from history — it travels in
          // `question` alone, so the prompt never sees the current question twice.
          history: annotation.messages
            .filter((message) => message.id !== pendingId)
            .slice(0, -1)
            .map(({ role, content }) => ({ role, content })),
          sectionId: annotation.sectionId,
          annotation,
          signal: controller.signal,
          onToken: (chunk) => {
            draft = updateMessageContent(draft, pendingId, (content) => content + chunk);
            setActive(draft);
          },
        });
      } catch (error) {
        const message = controller.signal.aborted
          ? "导师回答已停止。"
          : publicSafeErrorMessage(error, "导师暂时无法回答，请稍后重试。");
        setError(controller.signal.aborted ? "" : message);
        // Append the interruption notice instead of replacing the tokens already
        // streamed, so a partial answer is never silently discarded.
        draft = updateMessageContent(draft, pendingId, (content) => (content ? `${content}\n\n${message}` : message));
        setActive(draft);
      } finally {
        window.clearTimeout(timeout);
        setAnswering(false);
        controllerRef.current = null;
      }

      if (saved) setAnnotations((current) => upsertAnnotation(current, saved!));
      setActive(cloneAnnotation(saved ?? draft));
    },
    [course],
  );

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return false;
      if (answering) return false;
      if (!course) {
        setError("课程数据还在加载，请稍后再试。");
        return false;
      }
      setError("");
      // No anchored selection and no open thread → default to a free chapter-wide
      // chat so users can just talk to the tutor without selecting text first.
      const isChapter = active
        ? active.scope === "chapter" || !active.selectedText
        : target?.scope !== "anchored";

      const baseAnnotation: Annotation =
        active ??
        ({
          id: randomId(),
          courseId: course.id,
          chapterId,
          sectionId: target?.scope === "anchored" ? target.sectionId : undefined,
          scope: isChapter ? "chapter" : "anchored",
          selectedText: target?.scope === "anchored" ? target.selectedText : undefined,
          question: trimmed,
          messages: [],
          createdAt: new Date().toISOString(),
        } satisfies Annotation);

      const annotation = {
        ...baseAnnotation,
        messages: [
          ...baseAnnotation.messages,
          { id: randomId(), role: "user" as const, content: trimmed },
        ],
      };
      setActive(annotation);
      void streamAnswer(annotation, trimmed);
      return true;
    },
    [active, answering, chapterId, course, streamAnswer, target],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const regenerateLast = useCallback(async () => {
    if (!active || answering) return;
    const lastUser = [...active.messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    const lastUserIndex = active.messages.map((m) => m.id).lastIndexOf(lastUser.id);
    const trimmed: Annotation = { ...active, messages: active.messages.slice(0, lastUserIndex + 1) };
    setActive(trimmed);
    await streamAnswer(trimmed, lastUser.content);
  }, [active, answering, streamAnswer]);

  const deleteThread = useCallback(async (id: string) => {
    await apiFetch(`/api/annotations?id=${id}`, { method: "DELETE" }).catch(() => undefined);
    setAnnotations((current) => current.filter((item) => item.id !== id));
    setActive((current) => (current?.id === id ? undefined : current));
  }, []);

  return {
    annotations,
    active,
    target,
    answering,
    error,
    historyScope,
    setHistoryScope,
    reloadAnnotations,
    startAnchored,
    startGeneral,
    continueAnchored,
    openThread,
    clear,
    ask,
    stop,
    regenerateLast,
    deleteThread,
  };
}

function upsertAnnotation(annotations: Annotation[], annotation: Annotation) {
  const index = annotations.findIndex((item) => item.id === annotation.id);
  if (index === -1) return [...annotations, cloneAnnotation(annotation)];
  return annotations.map((item) => (item.id === annotation.id ? cloneAnnotation(annotation) : item));
}

function cloneAnnotation(annotation: Annotation): Annotation {
  return {
    ...annotation,
    messages: annotation.messages.map((message) => ({ ...message })),
  };
}

function appendMessage(annotation: Annotation, message: Annotation["messages"][number]): Annotation {
  return {
    ...annotation,
    messages: [...annotation.messages, message],
  };
}

function updateMessageContent(
  annotation: Annotation,
  messageId: string,
  update: (content: string) => string,
): Annotation {
  return {
    ...annotation,
    messages: annotation.messages.map((message) =>
      message.id === messageId ? { ...message, content: update(message.content) } : message,
    ),
  };
}

async function askTutorStreaming(input: {
  topic: string;
  selectedText: string;
  question: string;
  history: { role: string; content: string }[];
  sectionId?: string;
  annotation: Annotation;
  signal?: AbortSignal;
  onToken: (chunk: string) => void;
}): Promise<Annotation | undefined> {
  const response = await apiFetch("/api/annotations", {
    method: "POST",
    signal: input.signal,
    body: JSON.stringify({
      topic: input.topic,
      selectedText: input.selectedText,
      question: input.question,
      history: input.history,
      sectionId: input.sectionId,
      annotation: input.annotation,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error ?? `Tutor request failed (${response.status}).`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming not supported.");

  const decoder = new TextDecoder("utf-8");
  let saved: Annotation | undefined;
  let receivedTerminalEvent = false;
  const parser = createSseParser((event) => {
    if (!event.data) return;
    const parsed = JSON.parse(event.data);
    if (event.event === "token") {
      input.onToken(parsed.text ?? "");
    } else if (event.event === "done") {
      receivedTerminalEvent = true;
      saved = parsed.annotation ?? undefined;
    } else if (event.event === "error") {
      receivedTerminalEvent = true;
      throw new Error(parsed.error ?? "Tutor request failed.");
    }
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }

  parser.feed(decoder.decode());
  parser.flush();
  // A stream that ends without `done`/`error` (dropped connection, killed server)
  // must surface as an error instead of silently keeping a truncated answer.
  if (!receivedTerminalEvent) {
    throw new Error("Tutor stream ended before completion.");
  }
  return saved;
}
