import { parseJson } from "./ai";
import type { CoursePlannerInput, CourseSkeleton } from "./prompts/coursePlanner";

/**
 * Chapter-title review pass: an independent LLM call that runs after the
 * skeleton is planned and before the Course Bible/contracts are generated, so
 * every downstream reference (bible, chapterDependencies, contracts, outline)
 * inherits the reviewed titles. Root-cause prompt rules (years never belong
 * in titles) live in coursePlanner.ts; this pass is the enforcement layer.
 *
 * A deterministic `stripYearTagFromTitle` also exists for section titles
 * derived from requiredTopics (textbook outline), which never pass through
 * the LLM review.
 */

/** 迈向耦合系统（2024）/ 迈向耦合系统(2024年) → 迈向耦合系统 */
export function stripYearTagFromTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[（(]\s*(?:19|20)\d{2}\s*年?\s*[)）]\s*$/u, "")
    .trim();
  return cleaned || title.trim();
}

export function buildSkeletonTitleReviewPrompt(input: CoursePlannerInput, skeleton: CourseSkeleton) {
  const chapterLines = skeleton.chapters
    .map((chapter, index) => `${index + 1}. 标题：${chapter.title}\n   概述：${chapter.description}\n   任务：${chapter.purpose}`)
    .join("\n");

  return `你是一名教材标题审校员。下面是刚规划好的课程章节路线。请逐一审校每个章节标题，只找出需要修改的标题。

审校标准：
- 标题必须与本章 description/purpose 的实际内容匹配（例如内容是函数逼近下的价值预测，标题就不能写成「基于策略的预测」）。
- 标题必须是完整、通顺的中文短语，无病句、无错字。
- 标题不得含年份、版本号、括号标签等杂质（如「迈向耦合系统（2024）」要改成「迈向耦合系统」）。
- 标题不得含夸大或营销式措辞。

硬性规则：
- 第一章与最后一章（引言 / 总结与展望）禁止修改。
- 若课程要求（用户上传的目录/要求）指定了某章标题，必须保留其核心关键词，只做最小修正。
- 新标题不超过 30 个中文字符，不含年份与括号。
- 只输出需要修改的标题；无需修改的章节不要输出。若全部合格，输出 {"titles":[]}。
- 只输出合法 JSON，结构为：{"titles":[{"index":1,"title":"新标题","reason":"简短理由"}]}
- 第一个字符必须是 {，最后一个字符必须是 }。

课程主题：${input.topic}
课程目标：${input.goal}

章节路线：
${chapterLines}`;
}

export type SkeletonTitleReview = { index: number; title: string; reason?: string };

export function parseSkeletonTitleReviews(raw: string): SkeletonTitleReview[] {
  let parsed: { titles?: unknown };
  try {
    parsed = parseJson<{ titles?: unknown }>(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.titles)) return [];
  const reviews: SkeletonTitleReview[] = [];
  for (const entry of parsed.titles) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : undefined;
    const title = typeof record.title === "string" ? record.title.trim().slice(0, 80) : "";
    const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 120) : undefined;
    if (!Number.isInteger(index) || !title || index! < 1) continue;
    reviews.push({ index: index!, title, reason });
  }
  return reviews;
}

/**
 * Apply reviews by 1-based index. The first and last chapters (引言 /
 * 总结与展望) are never touched; duplicate titles are rejected. Returns the
 * updated skeleton and the number of applied changes.
 */
export function applySkeletonTitleReviews(
  skeleton: CourseSkeleton,
  reviews: SkeletonTitleReview[],
): { skeleton: CourseSkeleton; changed: number; rejected: { index: number; reason: string }[] } {
  const rejected: { index: number; reason: string }[] = [];
  const titles = skeleton.chapters.map((chapter) => chapter.title);
  const fixed = new Set([0, skeleton.chapters.length - 1]);
  let changed = 0;

  for (const review of reviews) {
    const position = review.index - 1;
    if (position < 0 || position >= skeleton.chapters.length) {
      rejected.push({ index: review.index, reason: "序号越界" });
      continue;
    }
    if (fixed.has(position)) {
      rejected.push({ index: review.index, reason: "引言/总结章标题固定，禁止修改" });
      continue;
    }
    const cleaned = stripYearTagFromTitle(review.title);
    if (cleaned === titles[position]) continue;
    if (titles.includes(cleaned)) {
      rejected.push({ index: review.index, reason: "新标题与既有章节标题重复" });
      continue;
    }
    titles[position] = cleaned;
    changed += 1;
  }

  return {
    skeleton: {
      ...skeleton,
      chapters: skeleton.chapters.map((chapter, index) => ({
        ...chapter,
        title: titles[index] ?? chapter.title,
      })),
    },
    changed,
    rejected,
  };
}
