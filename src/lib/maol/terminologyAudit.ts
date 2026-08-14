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
 * - Candidate generation is DETERMINISTIC: CJK n-grams (length 2-8, appearing
 *   ≥2 times per chapter) yield near-duplicate pairs (same length, exactly one
 *   differing character). LLM enumeration was abandoned — on 20k-char chapters
 *   the model both missed real variant spellings and blew its output budget.
 * - Only pairs whose two spellings co-occur inside the same chapter reach the
 *   judge, and the judge sees EVIDENCE: one real sentence of context per
 *   spelling. A word-pair judge without evidence happily merges opposites
 *   (硬更新/软更新) and different concepts (模仿学习/模型学习).
 * - Pairs are ranked by frequency imbalance (a rare spelling next to a
 *   dominant one is the signature of an inconsistency), so the judge's
 *   limited slots go to the most likely conflicts.
 * - Hard guards: both variants must contain CJK (no pure-English/acronym
 *   merges), transitive group merge (one spelling never gets two
 *   contradictory targets), and replacements only outside code fences plus
 *   chapter titles.
 *
 * Total LLM cost: exactly ONE judge call per book.
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

const AUDIT_TIMEOUT_MS = 180_000;
const MAX_NGRAMS_PER_CHAPTER = 300;
const MAX_NGRAMS_PER_BOOK = 3000;
const MAX_JUDGE_PAIRS = 60;

/**
 * Deterministic term candidate extraction: CJK runs of length 4-16 broken
 * into sliding 4-8 char windows, keeping only grams that appear at least
 * twice in the chapter. Three-character windows are skipped entirely — they
 * are dominated by cross-word shards (的动作, 为策略) that flood the judge's
 * slots. A shorter gram is suppressed when ≥90% of its occurrences are
 * covered by longer grams (价值函 ⊂ 价值函数). Complete recall, zero LLM cost.
 */
export function extractCjkNgrams(content: string, maxTerms = MAX_NGRAMS_PER_CHAPTER): string[] {
  const counts = new Map<string, number>();
  // Match whole CJK runs (up to 16 chars) so term counts don't get broken by
  // run truncation, then slide 4-8 char windows inside each run.
  for (const match of content.matchAll(/[\u4e00-\u9fff]{4,16}/gu)) {
    const run = match[0];
    for (let size = 4; size <= Math.min(8, run.length); size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        const gram = run.slice(start, start + size);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }
  const entries = [...counts.entries()].filter(([, count]) => count >= 2);
  // Longer grams first: accumulate how much of each shorter gram's frequency
  // is explained by longer grams containing it.
  entries.sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
  const covered = new Map<string, number>();
  const kept: [string, number][] = [];
  for (const [gram, count] of entries) {
    if ((covered.get(gram) ?? 0) >= count * 0.9) continue;
    kept.push([gram, count]);
    for (let size = 4; size < gram.length; size += 1) {
      for (let start = 0; start + size <= gram.length; start += 1) {
        const sub = gram.slice(start, start + size);
        covered.set(sub, (covered.get(sub) ?? 0) + count);
      }
    }
  }
  return kept
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([gram]) => gram);
}

/**
 * Near-duplicate seeds over the aggregated n-gram list: same length with
 * exactly one differing character. Purely a candidate generator — the
 * evidence judge decides whether the pair is truly the same concept.
 */
export function findNearDuplicatePairs(terms: string[]): { english?: string; variants: string[] }[] {
  const normalized = [...new Set(terms.map((term) => term.trim()))].filter(
    (term) => term.length >= 4 && term.length <= 8,
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

/**
 * Rank pairs for the judge's limited slots: frequency imbalance first (a rare
 * spelling beside a dominant one is the signature of an inconsistency), then
 * total frequency.
 */
export function rankCandidatePairs(
  pairs: { variants: string[] }[],
  chapterContents: string[],
) {
  return pairs
    .map((pair) => {
      const counts = pair.variants.map((variant) =>
        chapterContents.reduce((sum, content) => sum + occurrencesOutsideFences(content, variant), 0),
      );
      return {
        pair,
        imbalance: Math.abs((counts[0] ?? 0) - (counts[1] ?? 0)),
        total: (counts[0] ?? 0) + (counts[1] ?? 0),
      };
    })
    .sort((a, b) => b.imbalance - a.imbalance || b.total - a.total)
    .map((item) => item.pair);
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
- 不确定就判 same:false（宁漏勿错）。
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

/**
 * Merge groups that share a variant (transitive closure): "多步回报/n步回报"
 * + "n步回报/n步回溯" must become ONE group, otherwise the same spelling gets
 * two contradictory replacement targets.
 */
export function mergeTransitiveGroups(
  groups: { key: string; variants: string[] }[],
): { key: string; variants: string[] }[] {
  const union = new Map<string, string>();
  const find = (value: string): string => {
    const parent = union.get(value);
    if (parent === undefined) {
      union.set(value, value);
      return value;
    }
    if (parent === value) return value;
    const root = find(parent);
    union.set(value, root);
    return root;
  };
  const unite = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) union.set(rootB, rootA);
  };

  const variantsPerGroup = groups.map((group) => group.variants);
  for (const variants of variantsPerGroup) {
    for (let i = 1; i < variants.length; i += 1) {
      unite(variants[0]!, variants[i]!);
    }
  }

  const byRoot = new Map<string, Set<string>>();
  for (const variants of variantsPerGroup) {
    for (const variant of variants) {
      const root = find(variant);
      const set = byRoot.get(root) ?? new Set<string>();
      set.add(variant);
      byRoot.set(root, set);
    }
  }
  return [...byRoot.values()]
    .map((set) => [...set])
    .filter((variants) => variants.length >= 2)
    .map((variants) => ({ key: variants.join("\u0000"), variants }));
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
    const chapterContents = chapters.map(
      (chapter) => chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "",
    );

    // Stage 1 (deterministic, free): CJK n-grams per chapter → near-duplicate
    // seeds → same-chapter co-occurrence filter → rank by frequency imbalance.
    const allTerms = [...new Set(chapterContents.flatMap((content) => extractCjkNgrams(content)))].slice(0, MAX_NGRAMS_PER_BOOK);
    const candidates = rankCandidatePairs(
      filterCoOccurringPairs(findNearDuplicatePairs(allTerms), chapterContents),
      chapterContents,
    );

    // Stage 2 (one LLM call): evidence-backed judge over the ranked pairs.
    const judgeRaw = await dispatchAgentText({
      agent: "REVIEWER",
      prompt: buildConflictJudgementPrompt(candidates, chapterContents),
      temperature: 0.1,
      maxTokens: 2048,
      timeoutMs: AUDIT_TIMEOUT_MS,
      maxAttempts: 1,
      responseFormat: "json_object",
      overrides: options.overrides,
      mock: () => JSON.stringify({ groups: [] }),
    });

    const rejected: TerminologyAuditReport["rejected"] = [];
    const groups: { key: string; variants: string[] }[] = [];
    for (const decision of parseConflictGroups(judgeRaw)) {
      if (decision.same) {
        groups.push({ key: decision.key, variants: decision.variants });
      } else if (decision.reason || decision.variants.length >= 2) {
        rejected.push({ variants: decision.variants, reason: decision.reason || "判定为不同概念，已跳过。" });
      }
    }

    // Transitive merge: a spelling shared by two groups must resolve to ONE
    // canonical target, never two contradictory replacements.
    const mergedGroups = mergeTransitiveGroups(groups);

    const conflicts = buildConflictMap(mergedGroups, chapterContents);
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
      if (totalApplied === 0 || (nextContent === content && !titleChanged)) continue;
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
