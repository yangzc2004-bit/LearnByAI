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
 * of defect).
 *
 * Two-stage design, because asking an LLM to "find variant spellings" directly
 * inside a 20k-char chapter is a rare-event task it reliably fails (returns an
 * empty list). Instead:
 *   1. Per chapter (easy): enumerate the Chinese terms that actually appear.
 *   2. Deterministic seeds: near-duplicate pairs over the aggregated term list
 *      (same length, one differing character — catches 马尔科夫/马尔可夫,
 *      同策略/在策略) so real conflicts can never miss the judge.
 *   3. One short book-level call (easy): judge which candidate pairs are truly
 *      the same concept, and add any pairs it sees in the full term list.
 *   4. Deterministic canonical choice (Course Bible convention first, then the
 *      most frequent spelling) and fence-safe replacement, chapter by chapter.
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

const AUDIT_CONCURRENCY = 2;
const AUDIT_TIMEOUT_MS = 180_000;
const MAX_TERMS_PER_CHAPTER = 80;
const MAX_TERMS_PER_BOOK = 400;

export function buildTermExtractionPrompt(
  course: Course,
  chapterContent: string,
  chapterNumber: number,
  chapterTitle: string,
) {
  const conventions = {
    terminology: course.courseBible.terminology ?? [],
    writingConventions: course.courseBible.writingConventions ?? "",
  };
  return `你是一名教材术语提取员。下面是一本中文教材第 ${chapterNumber} 章《${chapterTitle}》的正文。

任务：逐段扫描正文，把其中出现的所有中文术语（专有名词、方法名、概念名，2 到 10 个字，可含英文缩写，如「Q 学习」「TD 误差」）逐一列出。这是机械的枚举任务，只列词本身，不要判断、不要解释。

只输出合法 JSON，结构为：
{"terms":["术语1","术语2"]}

规则：
- 只列真实出现在正文中的词，禁止编造。
- 按出现顺序列出，最多 ${MAX_TERMS_PER_CHAPTER} 个；重复出现的只列一次。
- 术语表用于全书一致性检查，宁可多列不可漏列。
- 只输出 JSON，第一个字符必须是 {，最后一个字符必须是 }。

Course Bible 术语约定（仅参考，不要照抄）：
${JSON.stringify(conventions)}

第 ${chapterNumber} 章《${chapterTitle}》正文：
${chapterContent}`;
}

export function parseChapterTerms(raw: string): string[] {
  let parsed: { terms?: unknown };
  try {
    parsed = parseJson<{ terms?: unknown }>(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.terms)) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of parsed.terms) {
    if (typeof entry !== "string") continue;
    const term = entry.trim().slice(0, 10);
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms.slice(0, MAX_TERMS_PER_CHAPTER);
}

/**
 * Deterministic near-duplicate seeds over the aggregated term list: same
 * length with exactly one differing character, or sharing a 2+ char head/tail
 * with a single-character difference elsewhere. Purely a candidate generator —
 * the book-level judge decides whether the pair is truly the same concept
 * (offline/online pairs like 离线策略/在线策略 are NOT).
 */
export function findNearDuplicatePairs(terms: string[]): { english?: string; variants: string[] }[] {
  const normalized = [...new Set(terms.map((term) => term.trim()))].filter(
    (term) => term.length >= 3 && term.length <= 8,
  );
  const pairs: { english?: string; variants: string[] }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      if (a === b) continue;
      const key = [a, b].sort().join("\u0000");
      if (seen.has(key)) continue;
      if (!isNearDuplicate(a, b)) continue;
      seen.add(key);
      pairs.push({ variants: [a, b] });
    }
  }
  return pairs;
}

function isNearDuplicate(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let k = 0; k < a.length; k += 1) {
    if (a[k] !== b[k]) diffs += 1;
  }
  return diffs === 1;
}

export function buildConflictClassificationPrompt(
  course: Course,
  allTerms: string[],
  candidatePairs: { english?: string; variants: string[] }[],
) {
  const termsText = allTerms.slice(0, MAX_TERMS_PER_BOOK).join("、");
  const pairsText = candidatePairs
    .slice(0, 60)
    .map((pair, index) => `${index + 1}. ${pair.variants.join(" / ")}`)
    .join("\n");
  return `你是一名教材术语审计员。一本中文教材的全部术语已提取如下，其中一部分「疑似同义异形」的候选对也已列出。

任务：找出「同一概念存在多种中文写法」的冲突组（例如「马尔科夫」与「马尔可夫」是同一概念 Markov 的两种写法；「同策略」与「在策略」都是 on-policy 的译名）。同义异形必须合并为一个冲突组；「离线策略」与「在线策略」这类反义或不同概念的对不要合并。

只输出合法 JSON，结构为：
{"conflicts":[{"english":"英文原词（可选）","variants":["写法1","写法2"]}]}

规则：
- 优先判断候选对；术语列表中还有候选对没覆盖的同义异形，也要输出。
- variants 只使用术语列表或候选对里真实出现的写法，禁止发明新词。
- 没有冲突就输出 {"conflicts":[]}。
- 只输出 JSON，第一个字符必须是 {，最后一个字符必须是 }。

候选对：
${pairsText || "（无）"}

全书术语列表：
${termsText}`;
}

export function parseConflictGroups(raw: string): { key: string; english?: string; variants: string[] }[] {
  let parsed: { conflicts?: unknown };
  try {
    parsed = parseJson<{ conflicts?: unknown }>(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.conflicts)) return [];
  const groups: { key: string; english?: string; variants: string[] }[] = [];
  for (const entry of parsed.conflicts) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const english = typeof record.english === "string" ? record.english.trim() : "";
    const variants = Array.isArray(record.variants)
      ? record.variants.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 20))
          .filter((item) => item.length >= 2)
      : [];
    const distinct = [...new Set(variants)];
    if (distinct.length < 2) continue;
    groups.push({
      key: (english || distinct[0] || "").toLowerCase().replace(/\s+/gu, " "),
      english: english || undefined,
      variants: distinct,
    });
  }
  return groups;
}

/** Map conflict groups into book-wide conflicts and locate their chapters. */
export function buildConflictMap(
  groups: { key: string; variants: string[] }[],
  chapterContents: string[],
): Map<string, TerminologyConflict> {
  const conflicts = new Map<string, TerminologyConflict>();
  for (const group of groups) {
    if (!group.key) continue;
    const chapters: number[] = [];
    for (let index = 0; index < chapterContents.length; index += 1) {
      if (group.variants.some((variant) => occurrencesOutsideFences(chapterContents[index] ?? "", variant) > 0)) {
        chapters.push(index + 1);
      }
    }
    if (chapters.length === 0) continue;
    conflicts.set(group.key, {
      key: group.key,
      variants: group.variants,
      occurrences: 0,
      chapters,
    });
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
    // Stage 1: per-chapter term enumeration (an easy task the model does well).
    const perChapter = await runInBatches(chapters, AUDIT_CONCURRENCY, async (chapter) => {
      const content = chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "";
      const raw = await dispatchAgentText({
        agent: "REVIEWER",
        prompt: buildTermExtractionPrompt(
          course,
          content,
          course.chapters.findIndex((item) => item.id === chapter.id) + 1,
          chapter.title,
        ),
        temperature: 0.1,
        maxTokens: 4096,
        timeoutMs: AUDIT_TIMEOUT_MS,
        maxAttempts: 1,
        responseFormat: "json_object",
        overrides: options.overrides,
        mock: () => JSON.stringify({ terms: [] }),
      });
      return parseChapterTerms(raw);
    });

    const allTerms = [...new Set(perChapter.flat())];
    const candidatePairs = findNearDuplicatePairs(allTerms);

    // Stage 2: one short book-level call judges the candidate pairs (easy).
    const judgeRaw = await dispatchAgentText({
      agent: "REVIEWER",
      prompt: buildConflictClassificationPrompt(course, allTerms, candidatePairs),
      temperature: 0.1,
      maxTokens: 2048,
      timeoutMs: AUDIT_TIMEOUT_MS,
      maxAttempts: 1,
      responseFormat: "json_object",
      overrides: options.overrides,
      mock: () => JSON.stringify({ conflicts: [] }),
    });
    const groups = parseConflictGroups(judgeRaw);

    const chapterContents = chapters.map(
      (chapter) => chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "",
    );
    const conflicts = buildConflictMap(groups, chapterContents);
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
