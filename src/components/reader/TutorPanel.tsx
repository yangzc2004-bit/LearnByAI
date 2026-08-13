"use client";

import { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Bot, MessageSquareQuote, SendHorizontal, Trash2, User, X } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { useTutor } from "@/lib/hooks/useTutor";
import { Annotation } from "@/lib/types";

type TutorPanelProps = {
  tutor: ReturnType<typeof useTutor>;
  courseId: string;
  chapterId: string;
  onClose: () => void;
};

export function TutorPanel({
  tutor,
  courseId,
  chapterId,
  onClose,
}: TutorPanelProps) {
  const router = useRouter();
  const { active, target, answering, annotations, error, historyScope } = tutor;
  // A conversation context exists once a thread is open (active) or a target is
  // chosen. With neither, the panel shows the history "home" — but the composer
  // stays available so users can just start chatting (defaults to chapter 泛问).
  const inConversation = Boolean(active || target);
  const anchoredText = active?.selectedText ?? (target?.scope === "anchored" ? target.selectedText : undefined);

  const suggestions = quickQuestionsFor(Boolean(anchoredText));

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("question") as HTMLInputElement;
    const question = input.value;
    void tutor.ask(question).then((sent) => {
      if (sent) input.value = "";
    }).catch(() => undefined);
  }

  function openThreadInContext(annotation: Annotation) {
    if (annotation.chapterId !== chapterId) {
      // Citations jump within the rendered chapter's DOM, so a thread from
      // another chapter must land on its own chapter first.
      sessionStorage.setItem("learnbyai-pending-thread", annotation.id);
      router.push(`/courses/${courseId}/chapters/${annotation.chapterId}`);
      return;
    }
    tutor.openThread(annotation);
  }

  return (
    <aside className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-primary" />
          <span className="font-mono text-[11px] font-medium text-primary uppercase tracking-wider">导师终端</span>
        </div>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {inConversation ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={tutor.clear}
                  className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                >
                  ← 历史
                </button>
              </div>
              {answering && (
                <span className="font-mono text-[10px] text-primary animate-pulse">思考中...</span>
              )}
            </div>
            {anchoredText ? (
              <div className="border-l-2 border-primary pl-3">
                <p className="font-mono text-[10px] text-muted-foreground mb-1">TARGET_TEXT</p>
                <div className="text-sm leading-relaxed text-foreground italic line-clamp-4">&quot;{anchoredText}&quot;</div>
              </div>
            ) : (
              <div className="border-l-2 border-border pl-3">
                <p className="font-mono text-[10px] text-muted-foreground">整章对话 · 关于本章的任何问题都可以问</p>
              </div>
            )}

            <div className="space-y-4">
              {(!active || active.messages.length === 0) && !answering && (
                <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {anchoredText ? "向导师追问这段内容吧。" : "问点什么开始对话吧，下面也有常见追问。"}
                </p>
              )}
              {active?.messages.map((message) => {
                const isUser = message.role === "user";
                return (
                  <div key={message.id} className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
                    <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${isUser ? "text-primary" : "text-muted-foreground"}`}>
                      {isUser ? <User size={11} /> : <Bot size={11} />}
                      {isUser ? "你" : "导师"}
                    </span>
                    <div className={isUser
                      ? "min-w-0 max-w-[75%] break-words rounded-lg rounded-tr-none border border-primary/25 bg-primary/10 px-3 py-1.5 text-foreground"
                      : "min-w-0 max-w-full break-words text-muted-foreground"}>
                      <MarkdownContent content={message.content} variant="chat" />
                    </div>
                  </div>
                );
              })}
              {answering && (
                <button onClick={tutor.stop} className="font-mono text-[10px] text-primary animate-pulse hover:underline">
                  处理中... 点击停止
                </button>
              )}
              {!answering && active && active.messages.some((m) => m.role === "assistant") && (
                <button onClick={() => void tutor.regenerateLast()} className="font-mono text-[10px] text-muted-foreground hover:text-primary">
                  ↻ 重答
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <button
              onClick={tutor.startGeneral}
              className="w-full border border-primary/40 bg-primary/5 px-3 py-2 font-mono text-[11px] text-primary transition-colors hover:bg-primary/10"
            >
              + 开启新对话
            </button>
            <div className="flex gap-1">
              <button
                onClick={() => tutor.setHistoryScope("chapter")}
                className={historyTabClass(historyScope === "chapter")}
              >
                本章
              </button>
              <button
                onClick={() => tutor.setHistoryScope("course")}
                className={historyTabClass(historyScope === "course")}
              >
                本课程
              </button>
            </div>
            <div className="font-mono text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
              讨论档案 · {annotations.length}
            </div>
            {annotations.length === 0 ? (
              <div className="flex flex-col items-center justify-center pt-12 text-center text-muted-foreground">
                <MessageSquareQuote size={28} className="mb-3 opacity-50" />
                <p className="font-mono text-xs leading-relaxed max-w-[200px]">直接在下方输入框提问，或选中正文针对某处提问。</p>
              </div>
            ) : (
              <div className="space-y-1">
                {annotations.map((annotation) => (
                  <div key={annotation.id} className="group flex items-start gap-1">
                    <button
                      onClick={() => openThreadInContext(annotation)}
                      className="flex-1 px-2 py-2 text-left text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                    >
                      <div className="text-xs line-clamp-1 font-medium">{annotation.title || annotation.question || "（无标题）"}</div>
                      <div className="mt-0.5 text-[10px] line-clamp-1 text-muted-foreground/70">
                        {annotation.selectedText ?? annotation.summary ?? "整章泛问"}
                      </div>
                      <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/50">{formatTime(annotation.createdAt)}</div>
                    </button>
                    <button
                      onClick={() => void tutor.deleteThread(annotation.id)}
                      className="mt-2 rounded p-1 text-muted-foreground/40 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      title="删除对话"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border bg-card p-4">
        {error && <p className="mb-3 text-xs leading-relaxed text-destructive">{error}</p>}
        {inConversation && (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((q) => (
              <button
                key={q}
                onClick={() => void tutor.ask(q)}
                disabled={answering}
                className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50 transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={submitQuestion} className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12px] text-primary">{">"}</span>
            <input
              name="question"
              placeholder={anchoredText ? "追问这段内容..." : "输入问题，直接和导师聊聊..."}
              autoComplete="off"
              disabled={answering}
              className="w-full bg-background border border-border py-2 pl-7 pr-3 font-mono text-[12px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={answering}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="发送问题"
            title="发送问题"
          >
            <SendHorizontal size={14} />
          </button>
        </form>
      </div>
    </aside>
  );
}

function quickQuestionsFor(anchored: boolean) {
  return anchored
    ? ["解释这段内容的直觉", "给我一个具体例子", "推导这里的公式", "质疑这段内容"]
    : ["本章核心概念是什么", "给我一个具体例子", "梳理本章结构", "质疑本章内容"];
}

function historyTabClass(active: boolean) {
  return `rounded px-2 py-1 font-mono text-[10px] transition-colors ${
    active
      ? "bg-primary/15 text-primary"
      : "text-muted-foreground hover:text-foreground"
  }`;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
