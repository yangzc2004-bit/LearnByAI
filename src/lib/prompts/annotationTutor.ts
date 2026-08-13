import { ExplanationStyle, LearningMode } from "../types";
import { buildTeachingGuidance } from "./styleGuidance";
import { tutorSkill } from "./textbookSkill";

export type AnnotationTutorInput = {
  topic: string;
  /** Empty when the user asks a chapter-level (泛问) question with no anchored span. */
  selectedText: string;
  question: string;
  history: { role: string; content: string }[];
  /** Optional transparency note shown before the history (e.g. compaction). */
  historyNote?: string;
  context?: {
    goal?: string;
    learnerProfile?: string;
    teachingStyle?: string;
    styles?: ExplanationStyle[];
    learningMode?: LearningMode;
    chapterTitle?: string;
    chapterDescription?: string;
    chapterPurpose?: string;
    previousChapterTitle?: string;
    nextChapterTitle?: string;
    chapterSummary?: string;
    bridgeToNext?: string;
    sectionMap?: { label: string; title: string; purpose: string }[];
    sectionContent?: string;
    chapterContent?: string;
    terminology?: { term: string; definition: string }[];
  };
};

export function buildAnnotationTutorPrompt(input: AnnotationTutorInput) {
  const history = dedupeTrailingQuestion(input.history, input.question)
    .map((item) => `${item.role}: ${item.content}`)
    .join("\n");

  const ctx = input.context;
  const teaching = ctx?.styles?.length || ctx?.learningMode
    ? buildTeachingGuidance(ctx.styles ?? [], ctx.learningMode ?? "standard")
    : ctx?.teachingStyle;
  const contextSection = ctx
    ? [
        ctx.learnerProfile ? `学习者画像：${ctx.learnerProfile}` : "",
        ctx.goal ? `课程目标：${ctx.goal}` : "",
        teaching ? `讲解风格与学习方式：${teaching}` : "",
        ctx.chapterTitle ? `当前章节：${ctx.chapterTitle}` : "",
        ctx.chapterPurpose ? `章节任务：${ctx.chapterPurpose}` : "",
        ctx.chapterDescription ? `章节摘要：${ctx.chapterDescription}` : "",
        ctx.chapterSummary ? `本章内容概要：${ctx.chapterSummary}` : "",
        ctx.bridgeToNext ? `本章为下一章铺垫（仅供衔接参考）：${ctx.bridgeToNext}` : "",
        ctx.sectionMap?.length
          ? `章节地图（引用教材时使用节号）：\n${ctx.sectionMap.map((s) => `- ${s.label} ${s.title}：${s.purpose}`).join("\n")}`
          : "",
        ctx.sectionContent ? `选中段落所在小节的正文：\n${ctx.sectionContent}` : "",
        ctx.chapterContent ? `本章正文（完整内容，回答据此展开）：\n${ctx.chapterContent}` : "",
        ctx.previousChapterTitle ? `上一章：${ctx.previousChapterTitle}` : "",
        ctx.nextChapterTitle ? `下一章：${ctx.nextChapterTitle}` : "",
        ctx.terminology?.length
          ? `课程术语表：\n${ctx.terminology.map((t) => `- ${t.term}: ${t.definition}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const anchored = Boolean(input.selectedText.trim());
  const focusSection = anchored
    ? `用户正在阅读教材，并针对选中的原文向你提问。

选中的原文：
${input.selectedText}`
    : `用户正在阅读本章，并针对本章整体向你提问（未选定具体段落）。请基于本章已讲内容回答整体性问题。`;

  return `${tutorSkill()}

# Task: Anchored Tutoring

${focusSection}

${contextSection ? `## 课程与章节上下文\n${contextSection}\n` : ""}
课程主题：${input.topic}

此前讨论：
${input.historyNote ? `${input.historyNote}\n` : ""}${history}

用户问题：${input.question}

回答要求：
- 直接回答当前问题。
- 使用 Markdown。
- 如果用户质疑正确性，请明确判断依据、适用条件和不确定性。
- 不要修改教材正文，只解释内容。
- 引用教材正文时，紧跟被引陈述输出章节地图中的节号标记 \`[§n]\`；不要引用地图中不存在的节号，也不要在代码块或公式内使用引用标记。
- 使用术语表中的标准术语；如果必须引入新术语，给出临时定义。`;
}

function dedupeTrailingQuestion(
  history: { role: string; content: string }[],
  question: string,
) {
  if (history.length === 0) return history;
  const last = history[history.length - 1];
  if (last.role === "user" && last.content.trim() === question.trim()) {
    return history.slice(0, -1);
  }
  return history;
}
