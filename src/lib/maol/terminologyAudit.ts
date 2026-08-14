import { parseJson } from "../ai";
import { markdownToSections } from "./integrator";
import { updateServerChapter } from "../serverStore";
import { safeErrorMessage } from "../safeError";
import { Course } from "../types";
import { dispatchAgentText } from "./dispatcher";
import { assertMockFallbackAllowed } from "./fallback";
import { ModelOverrides } from "../modelOverrides";

/**
 * Whole-book terminology consistency audit (the "马尔科夫 vs 马尔可夫" class
 * of defect). Per-chapter extraction calls (REVIEWER slot) list only terms
 * with suspected multi-spelling usage; the results are aggregated across the
 * book, a canonical form is chosen deterministically (Course Bible convention
 * first, then the most frequent spelling), and the losing spellings are
 * replaced outside code fences, chapter by chapter.
 *
 * The deterministic replacement step keeps the audit safe: nothing is
 * rewritten by an LLM, only surface-form unification of the exact variant
 * tokens the extractor reported.
 */

export type TerminologyReplacement = { from: string; to: string };

export type TerminologyConflict = {
  key: string;
  variants: string[];
  occurrences: number;
  chapters: number[];
};

export type TerminologyAuditReport = {
  status: "ok" | "skipped" | "failed";
  conflicts: TerminologyConflict[];
  replacements: TerminologyReplacement[];
  appliedToChapters: { chapterId: string; title: string; replacements: number }[];
  error?: string;
};

type ChapterTermEntry = {
  english?: string;
  chinese?: string;
  variants?: string[];
};

const AUDIT_CONCURRENCY = 2;
const AUDIT_TIMEOUT_MS = 180_000;

export function buildTerminologyAuditPrompt(
  course: Course,
  chapterContent: string,
  chapterNumber: number,
  chapterTitle: string,
) {
  const conventions = {
    terminology: course.courseBible.terminology ?? [],
    writingConventions: course.courseBible.writingConventions ?? "",
  };
  return `你是一名教材术语审计员。下面是一本中文教材其中一章的正文与 Course Bible 术语约定。

任务：只找出「疑似同一概念在中文里出现多种写法」的术语冲突，例如「马尔科夫」vs「马尔可夫」、「同策略」vs「在策略」。不要把中英对照（「策略梯度」与 policy gradient）算作冲突；只有同一语言内部存在两种以上写法时才列出。

只输出合法 JSON，不要输出 Markdown 或解释。结构为：
{"terms":[{"english":"英文原词（可选）","chinese":"本章最常见的写法","variants":["写法1","写法2"]}]}

规则：
- variants 只列出你在本章正文里真实看到的不同写法（必须包含 chinese 本身），禁止臆造。
- 每个 variant 不超过 20 个字符；每个 term 的 variants 最多 4 个。
- 没有可疑冲突就输出 {"terms":[]}。
- 只输出 JSON，第一个字符必须是 {，最后一个字符必须是 }。

Course Bible 术语约定：
${JSON.stringify(conventions)}

第 ${chapterNumber} 章《${chapterTitle}》正文：
${chapterContent}`;
}

export function parseChapterTermVariants(raw: string): ChapterTermEntry[] {
  let parsed: { terms?: unknown };
  try {
    parsed = parseJson<{ terms?: unknown }>(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.terms)) return [];
  const entries: ChapterTermEntry[] = [];
  for (const entry of parsed.terms) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const english = typeof record.english === "string" ? record.english.trim() : "";
    const chinese = typeof record.chinese === "string" ? record.chinese.trim() : "";
    const variants = Array.isArray(record.variants)
      ? record.variants.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 20))
          .filter((item) => item.length >= 2)
      : [];
    const merged = [...new Set([chinese, ...variants].filter(Boolean))].slice(0, 4);
    if (merged.length < 2) continue;
    entries.push({ english: english || undefined, chinese: merged[0], variants: merged });
  }
  return entries;
}

/** Group per-chapter variant lists into book-wide conflicts. */
export function aggregateTermConflicts(
  perChapter: { chapterIndex: number; entries: ChapterTermEntry[] }[],
): Map<string, TerminologyConflict> {
  const conflicts = new Map<string, TerminologyConflict>();
  for (const { chapterIndex, entries } of perChapter) {
    for (const entry of entries) {
      const key = (entry.english || entry.chinese || "").toLowerCase().replace(/\s+/gu, " ");
      if (!key) continue;
      const existing = conflicts.get(key);
      if (existing) {
        for (const variant of entry.variants ?? []) {
          if (!existing.variants.includes(variant)) existing.variants.push(variant);
        }
        if (!existing.chapters.includes(chapterIndex)) existing.chapters.push(chapterIndex);
      } else {
        conflicts.set(key, {
          key,
          variants: [...(entry.variants ?? [])],
          occurrences: 0,
          chapters: [chapterIndex],
        });
      }
    }
  }
  return conflicts;
}

/** Count every variant's occurrences across the book (outside code fences). */
export function countVariantOccurrences(chapterContents: string[], conflicts: Map<string, TerminologyConflict>) {
  for (const conflict of conflicts.values()) {
    let total = 0;
    for (const variant of conflict.variants) {
      for (const content of chapterContents) {
        total += occurrencesOutsideFences(content, variant);
      }
    }
    conflict.occurrences = total;
  }
}

/**
 * Pick the canonical spelling for each conflict: a Course Bible terminology
 * entry that matches a variant wins; otherwise the most frequent spelling.
 */
export function chooseCanonicalReplacements(
  conflicts: Map<string, TerminologyConflict>,
  chapterContents: string[],
  bibleTerms: { term: string; definition?: string }[],
): { replacements: TerminologyReplacement[]; conflicts: TerminologyConflict[] } {
  const replacements: TerminologyReplacement[] = [];
  const resolved: TerminologyConflict[] = [];
  const seen = new Set<string>();

  for (const conflict of conflicts.values()) {
    const variants = conflict.variants;
    if (variants.length < 2) continue;
    const distinct = variants.filter((item, index) => variants.indexOf(item) === index);
    if (distinct.length < 2) continue;

    // A replacement must not be a substring of the canonical form (would
    // corrupt the longer word) and must not swallow English/Latin tokens.
    const safePair = (from: string, to: string) =>
      from !== to && from.length >= 2 && !to.includes(from) && /[\u4e00-\u9fff]|[A-Za-z]{2,}/u.test(from);

    const bibleMatch = bibleTerms.find((term) =>
      distinct.some((variant) => term.term.includes(variant) || variant.includes(term.term)),
    );
    const bibleForm = bibleMatch?.term;

    const counts = distinct.map((variant) =>
      chapterContents.reduce((sum, content) => sum + occurrencesOutsideFences(content, variant), 0),
    );
    const canonical = bibleForm && distinct.includes(bibleForm)
      ? bibleForm
      : distinct[counts.indexOf(Math.max(...counts))] ?? distinct[0]!;

    resolved.push({ ...conflict, variants: distinct });
    for (const variant of distinct) {
      if (variant === canonical) continue;
      if (!safePair(variant, canonical)) continue;
      const key = `${variant}\u0000${canonical}`;
      if (seen.has(key)) continue;
      seen.add(key);
      replacements.push({ from: variant, to: canonical });
    }
  }

  return { replacements, conflicts: resolved };
}

/**
 * Replace variant spellings with the canonical form, skipping fenced code
 * blocks (code must never be rewritten by a terminology pass).
 */
export function applyTerminologyReplacements(markdown: string, replacements: TerminologyReplacement[]): { content: string; applied: number } {
  // Defense in depth: a replacement whose source is a substring of its target
  // would corrupt the longer word; short tokens are too risky to rewrite.
  const ordered = replacements
    .filter((item) => item.from !== item.to && item.from.length >= 2 && !item.to.includes(item.from))
    .sort((a, b) => b.from.length - a.from.length);
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let inFence = false;
  let applied = 0;

  for (const line of lines) {
    if (/^(```|~~~)/u.test(line.trimStart())) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let next = line;
    for (const replacement of ordered) {
      if (!next.includes(replacement.from)) continue;
      const count = next.split(replacement.from).length - 1;
      applied += count;
      next = next.split(replacement.from).join(replacement.to);
    }
    out.push(next);
  }
  return { content: out.join("\n"), applied };
}

function occurrencesOutsideFences(content: string, token: string) {
  let count = 0;
  const lines = content.split(/\r?\n/u);
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/u.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    count += line.split(token).length - 1;
  }
  return count;
}

async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    for (let j = 0; j < batch.length; j += 1) {
      results[i + j] = batchResults[j]!;
    }
  }
  return results;
}

export async function runTerminologyAudit(
  course: Course,
  options: { overrides?: ModelOverrides; request?: Request; dryRun?: boolean } = {},
): Promise<TerminologyAuditReport> {
  const chapters = course.chapters.filter((chapter) => {
    const content = chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "";
    return content.trim().length > 0;
  });
  if (chapters.length < 2) {
    return { status: "skipped", conflicts: [], replacements: [], appliedToChapters: [] };
  }

  try {
    const perChapter = await runInBatches(chapters, AUDIT_CONCURRENCY, async (chapter) => {
      const content = chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "";
      const raw = await dispatchAgentText({
        agent: "REVIEWER",
        prompt: buildTerminologyAuditPrompt(
          course,
          content,
          course.chapters.findIndex((item) => item.id === chapter.id) + 1,
          chapter.title,
        ),
        temperature: 0.1,
        maxTokens: 2048,
        timeoutMs: AUDIT_TIMEOUT_MS,
        maxAttempts: 1,
        responseFormat: "json_object",
        overrides: options.overrides,
        mock: () => JSON.stringify({ terms: [] }),
      });
      const entries = parseChapterTermVariants(raw);
      const chapterIndex = course.chapters.findIndex((item) => item.id === chapter.id);
      return { chapterIndex, entries };
    });

    const conflicts = aggregateTermConflicts(perChapter);
    const chapterContents = chapters.map(
      (chapter) => chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "",
    );
    countVariantOccurrences(chapterContents, conflicts);
    const { replacements, conflicts: resolved } = chooseCanonicalReplacements(
      conflicts,
      chapterContents,
      course.courseBible.terminology ?? [],
    );

    if (replacements.length === 0) {
      return { status: "ok", conflicts: resolved, replacements: [], appliedToChapters: [] };
    }

    const appliedToChapters: TerminologyAuditReport["appliedToChapters"] = [];
    for (const chapter of chapters) {
      const content = chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "";
      const { content: nextContent, applied } = applyTerminologyReplacements(content, replacements);
      if (applied === 0 || nextContent === content) continue;
      if (!options.dryRun) {
        const sections = chapter.sections?.length
          ? markdownToSections(chapter, nextContent)
          : chapter.sections;
        await updateServerChapter(
          course,
          chapter.id,
          { content: nextContent, ...(sections ? { sections } : {}) },
          options.request,
        );
      }
      appliedToChapters.push({ chapterId: chapter.id, title: chapter.title, replacements: applied });
    }

    return {
      status: "ok",
      conflicts: resolved,
      replacements,
      appliedToChapters,
    };
  } catch (error) {
    // Real-provider failures surface; mock fallback is only allowed where the
    // platform rules permit it (no key configured).
    assertMockFallbackAllowed(error, options.overrides, "REVIEWER");
    return {
      status: "failed",
      conflicts: [],
      replacements: [],
      appliedToChapters: [],
      error: safeErrorMessage(error, "术语一致性审计失败。"),
    };
  }
}
