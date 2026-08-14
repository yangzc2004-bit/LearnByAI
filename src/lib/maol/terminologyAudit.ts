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
 * Design notes, learned from real-book dry runs:
 * - Asking an LLM to "find variant spellings" inside a 20k-char chapter is a
 *   rare-event task it reliably fails (returns an empty list). Per-chapter
 *   TERM ENUMERATION is easy and reliable instead.
 * - Near-duplicate pairs (same length, one differing character) over the
 *   aggregated term list guarantee that real conflicts reach the judge.
 * - A judge that sees only the two words happily merges opposites (硬更新/软
 *   更新) and different concepts (模仿学习/模型学习). So the judge sees
 *   EVIDENCE: both words must co-occur in one chapter, and the prompt carries
 *   one real sentence of context for each spelling.
 * - Hard guards: both variants must contain CJK (no pure-English/acronym
 *   merges like GRPO→TRPO), and the losing spelling is replaced only outside
 *   code fences, plus in the chapter title.
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
  rejected: { variants: string[]; reason: string }[];
  replacements: TerminologyReplacement[];
  appliedToChapters: { chapterId: string; title: string; replacements: number }[];
  error?: string;
};

const AUDIT_CONCURRENCY = 2;
const AUDIT_TIMEOUT_MS = 180_000;
const MAX_TERMS_PER_CHAPTER = 80;
const MAX_TERMS_PER_BOOK = 400;
const MAX_JUDGE_PAIRS = 60;

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
 * length with exactly one differing character. Purely a candidate generator —
 * the evidence judge decides whether the pair is truly the same concept.
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

/**
 * Only pairs whose two spellings co-occur inside the same chapter reach the
 * judge: a true inconsistency usually mixes both spellings in one place, while
 * cross-chapter-only pairs are much more likely to be different concepts.
 */
export function filterCoOccurringPairs(
  pairs: { variants: string[] }[],
  chapterContents: string[],
) {
  return pairs.filter((pair) =>
    chapterContents.some(
      (content) =>
        occurrencesOutsideFences(content, pair.variants[0] ?? "") > 0 &&
        occurrencesOutsideFences(content, pair.variants[1] ?? "") > 0,
    ),
  );
}

/** Extract a short real sentence of context around the first occurrence. */
export function excerptAround(content: string, token: string, radius = 50): string {
  const index = content.indexOf(token);
  if (index === -1) return "";
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + token.length + radius);
  return content.slice(start, end).replace(/\s+/gu, " ").trim();
}

export function buildConflictJudgementPrompt(
  pairs: { variants: string[] }[],
  chapterContents: string[],
) {
  const evidence = pairs
    .slice(0, MAX_JUDGE_PAIRS)
    .map((pair, index) => {
      const [a, b] = pair.variants;
      const chapter = chapterContents.find(
        (content) =>
          occurrencesOutsideFences(content, a ?? "") > 0 &&
          occurrencesOutsideFences(content, b ?? "") > 0,
      );
      const excerptA = chapter ? excerptAround(chapter, a ?? "") : "";
      const excerptB = chapter ? excerptAround(chapter, b ?? "") : "";
      return [
        `${index + 1}. 「${a}」 / 「${b}」`,
        excerptA ? `   「${a}」上下文：…${excerptA}…` : "",
        excerptB ? `   「${b}」上下文：…${excerptB}…` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n");

  return `你是一名教材术语审计员。下面是若干「疑似同义异形」的术语候选对，每个候选对都附了教材原文中的真实上下文。

任务：逐一判断这两个词在该教材语境中是否指向同一概念、在同一位置可以互换而不改变含义。判断依据必须是给出的上下文，不是词形相似。

只输出合法 JSON，结构为：
{"groups":[{"variants":["词A","词B"],"same":true,"reason":"简短理由"}]}

判定规则：
- 只有「同一概念的两种译名/写法」才判 same:true（如「马尔科夫」与「马尔可夫」同为 Markov；「同策略」与「在策略」同为 on-policy；「回放缓冲区」与「重放缓冲区」同为 replay buffer）。
- 反义词、相反操作、不同概念、不同算法必须判 same:false，例如「硬更新」与「软更新」、「旧策略」与「新策略」、「模仿学习」与「模型学习」、「正态分布」与「状态分布」、「泛化误差」与「优化误差」。
- 纯英文缩写对（如 GRPO 与 TRPO）一律 same:false。
- 只输出 JSON，第一个字符必须是 {，最后一个字符必须是 }。

候选对与上下文：
${evidence || "（无候选对）"}`;
}

export function parseConflictGroups(raw: string): { key: string; variants: string[]; same: boolean; reason: string }[] {
  let parsed: { groups?: unknown };
  try {
    parsed = parseJson<{ groups?: unknown }>(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.groups)) return [];
  const groups: { key: string; variants: string[]; same: boolean; reason: string }[] = [];
  for (const entry of parsed.groups) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const variants = Array.isArray(record.variants)
      ? record.variants.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 20))
          .filter((item) => item.length >= 2)
      : [];
    const distinct = [...new Set(variants)];
    if (distinct.length < 2) continue;
    const same = record.same === true;
    const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 120) : "";
    groups.push({ key: distinct.join("\u0000"), variants: distinct, same, reason });
  }
  return groups;
}

/** Map verified conflict groups into book-wide conflicts and locate chapters. */
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

/** Both variants must contain CJK — pure-English/acronym merges are forbidden. */
function isCjkVariant(value: string) {
  return /[\u4e00-\u9fff]/u.test(value) && !/[A-Za-z]{2,}/u.test(value);
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
    const variants = conflict.variants.filter(isCjkVariant);
    if (variants.length < 2) continue;
    const distinct = variants.filter((item, index) => variants.indexOf(item) === index);
    if (distinct.length < 2) continue;

    // A replacement must not be a substring of the canonical form (would
    // corrupt the longer word).
    const safePair = (from: string, to: string) =>
      from !== to && from.length >= 2 && !to.includes(from);

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

/** Apply replacements to a plain string (chapter titles), no fences involved. */
export function applyTerminologyReplacementsToString(value: string, replacements: TerminologyReplacement[]): string {
  let next = value;
  for (const replacement of replacements) {
    next = next.split(replacement.from).join(replacement.to);
  }
  return next;
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
    return { status: "skipped", conflicts: [], rejected: [], replacements: [], appliedToChapters: [] };
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

    const allTerms = [...new Set(perChapter.flat())].slice(0, MAX_TERMS_PER_BOOK);
    const chapterContents = chapters.map(
      (chapter) => chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "",
    );

    // Deterministic seeds, filtered to same-chapter co-occurrence only.
    const coOccurring = filterCoOccurringPairs(findNearDuplicatePairs(allTerms), chapterContents);

    const rejected: TerminologyAuditReport["rejected"] = [];
    const groups: { key: string; variants: string[] }[] = [];
    if (coOccurring.length > 0) {
      // Stage 2: one short evidence-backed judge call.
      const judgeRaw = await dispatchAgentText({
        agent: "REVIEWER",
        prompt: buildConflictJudgementPrompt(coOccurring, chapterContents),
        temperature: 0.1,
        maxTokens: 2048,
        timeoutMs: AUDIT_TIMEOUT_MS,
        maxAttempts: 1,
        responseFormat: "json_object",
        overrides: options.overrides,
        mock: () => JSON.stringify({ groups: [] }),
      });
      for (const decision of parseConflictGroups(judgeRaw)) {
        if (decision.same) {
          groups.push({ key: decision.key, variants: decision.variants });
        } else if (decision.reason || decision.variants.length >= 2) {
          rejected.push({ variants: decision.variants, reason: decision.reason || "判定为不同概念，已跳过。" });
        }
      }
    }

    const conflicts = buildConflictMap(groups, chapterContents);
    countVariantOccurrences(chapterContents, conflicts);
    const { replacements, conflicts: resolved } = chooseCanonicalReplacements(
      conflicts,
      chapterContents,
      course.courseBible.terminology ?? [],
    );

    if (replacements.length === 0) {
      return { status: "ok", conflicts: resolved, rejected, replacements: [], appliedToChapters: [] };
    }

    const appliedToChapters: TerminologyAuditReport["appliedToChapters"] = [];
    for (const chapter of chapters) {
      const content = chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "";
      const { content: nextContent, applied } = applyTerminologyReplacements(content, replacements);
      const nextTitle = applyTerminologyReplacementsToString(chapter.title, replacements);
      const titleChanged = nextTitle !== chapter.title;
      const totalApplied = applied + (titleChanged ? 1 : 0);
      if (totalApplied === 0 || nextContent === content && !titleChanged) continue;
      if (!options.dryRun) {
        const sections = chapter.sections?.length
          ? markdownToSections(chapter, nextContent)
          : chapter.sections;
        await updateServerChapter(
          course,
          chapter.id,
          { content: nextContent, ...(sections ? { sections } : {}), ...(titleChanged ? { title: nextTitle } : {}) },
          options.request,
        );
      }
      appliedToChapters.push({ chapterId: chapter.id, title: nextTitle, replacements: totalApplied });
    }

    return {
      status: "ok",
      conflicts: resolved,
      rejected,
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
      rejected: [],
      replacements: [],
      appliedToChapters: [],
      error: safeErrorMessage(error, "术语一致性审计失败。"),
    };
  }
}
