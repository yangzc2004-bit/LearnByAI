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
const MAX_JUDGE_PAIRS = 60;

/**
 * Full CJK gram map (length 4-8, whole runs up to 16 chars so term counts
 * don't get broken at run seams). Unfiltered on purpose: the rare side of a
 * real conflict (马尔科夫, appearing once next to 马尔可夫's dozens) must
 * survive into candidate pairing.
 */
export function extractCjkGrams(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(/[\u4e00-\u9fff]{4,16}/gu)) {
    const run = match[0];
    for (let size = 4; size <= Math.min(8, run.length); size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        const gram = run.slice(start, start + size);
        counts.set(gram, (counts.get(gram) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function isNearDuplicate(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let k = 0; k < a.length; k += 1) {
    if (a[k] !== b[k]) {
      diffs += 1;
      if (diffs > 1) return false;
    }
  }
  return diffs === 1;
}

/**
 * Candidate pairs within one chapter: every frequent gram (count ≥ 2) is
 * matched against ALL same-length grams (including count-1 ones), so a rare
 * spelling is never lost. Chapter-title grams are matched against the body
 * too and tagged — a title/body spelling split is the most visible conflict
 * (马尔科夫决策过程 as a chapter title vs 马尔可夫 in the body). Pair rank:
 * title matches first, then rare side ascending, then total frequency.
 */
export function generateChapterCandidatePairs(
  content: string,
  title?: string,
  maxPairs = 300,
): { variants: string[]; rare: number; imbalance: number; total: number; title: boolean }[] {
  const counts = extractCjkGrams(content);
  const frequent = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 400);
  const byLength = new Map<number, string[]>();
  for (const gram of counts.keys()) {
    const list = byLength.get(gram.length) ?? [];
    list.push(gram);
    byLength.set(gram.length, list);
  }
  const titleGrams = title ? [...extractCjkGrams(title).keys()] : [];

  const pairs = new Map<string, { variants: string[]; rare: number; imbalance: number; total: number; title: boolean }>();
  const addPair = (a: string, aCount: number, b: string, bCount: number, title: boolean) => {
    if (a === b || !isNearDuplicate(a, b)) return;
    const rare = Math.min(aCount, bCount);
    const imbalance = Math.abs(aCount - bCount);
    const key = [a, b].sort().join("\u0000");
    const existing = pairs.get(key);
    if (!existing || title || rare < existing.rare || (rare === existing.rare && aCount + bCount > existing.total)) {
      pairs.set(key, { variants: [a, b], rare, imbalance, total: aCount + bCount, title: title || existing?.title || false });
    }
  };

  for (const [frequentGram, frequentCount] of frequent) {
    for (const partner of byLength.get(frequentGram.length) ?? []) {
      if (partner === frequentGram) continue;
      addPair(frequentGram, frequentCount, partner, counts.get(partner) ?? 1, false);
    }
  }
  // Title grams against the body — the rare side here is almost always the
  // interesting one (title says 马尔科夫, body says 马尔可夫).
  for (const titleGram of titleGrams) {
    for (const partner of byLength.get(titleGram.length) ?? []) {
      if (partner === titleGram) continue;
      addPair(titleGram, 1, partner, counts.get(partner) ?? 1, true);
    }
  }

  return [...pairs.values()]
    .sort(
      (a, b) =>
        Number(b.title) - Number(a.title) ||
        a.rare - b.rare ||
        b.total - a.total ||
        a.imbalance - b.imbalance,
    )
    .slice(0, maxPairs);
}

/**
 * Merge per-chapter candidate pairs into one book-level ranked list for the
 * judge: title conflicts first, then rare-side count ascending (the 1-vs-65
 * signature), then total frequency descending.
 */
export function rankBookCandidates(
  chapterPairs: { variants: string[]; rare: number; imbalance: number; total: number; title: boolean }[][],
  chapterContents: string[],
  maxPairs = 60,
) {
  const merged = new Map<string, { variants: string[]; rare: number; imbalance: number; total: number; title: boolean }>();
  for (const pairs of chapterPairs) {
    for (const pair of pairs) {
      const key = pair.variants.sort().join("\u0000");
      const existing = merged.get(key);
      if (!existing || pair.title || pair.rare < existing.rare || (pair.rare === existing.rare && pair.total > existing.total)) {
        merged.set(key, pair);
      }
    }
  }
  return [...merged.values()]
    .map((pair) => {
      // Ranking counts use the BODY only: title occurrences would inflate the
      // rare side (title 马尔科夫 + body 马尔科夫 = rare 2) and push the pair
      // below rare-1 shard pairs in the judge's limited slots. Titles still
      // count for conflict detection, occurrence totals and canonical choice.
      const counts = pair.variants.map((variant) =>
        chapterContents.reduce((sum, content) => sum + occurrencesOutsideFences(content, variant), 0),
      );
      return {
        variants: pair.variants,
        rare: Math.min(counts[0] ?? 0, counts[1] ?? 0),
        imbalance: Math.abs((counts[0] ?? 0) - (counts[1] ?? 0)),
        total: (counts[0] ?? 0) + (counts[1] ?? 0),
        title: pair.title,
      };
    })
    .filter((pair) => pair.total > 0)
    .sort(
      (a, b) =>
        Number(b.title) - Number(a.title) ||
        a.rare - b.rare ||
        b.total - a.total ||
        a.imbalance - b.imbalance,
    )
    .slice(0, maxPairs)
    .map((pair) => ({ variants: pair.variants }));
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
  titleContents: string[] = [],
) {
  const evidence = pairs
    .slice(0, MAX_JUDGE_PAIRS)
    .map((pair, index) => {
      const [a, b] = pair.variants;
      const chapterIndex = chapterContents.findIndex(
        (content, i) =>
          (occurrencesOutsideFences(content, a ?? "") > 0 || occurrencesInTitle(titleContents[i] ?? "", a ?? "") > 0) &&
          (occurrencesOutsideFences(content, b ?? "") > 0 || occurrencesInTitle(titleContents[i] ?? "", b ?? "") > 0),
      );
      const excerptA = chapterIndex >= 0 ? excerptAround(chapterContents[chapterIndex] ?? "", a ?? "") : "";
      const excerptB = chapterIndex >= 0 ? excerptAround(chapterContents[chapterIndex] ?? "", b ?? "") : "";
      // A variant that lives only in the chapter title has no body context —
      // say so explicitly instead of showing an empty excerpt.
      const contextFor = (variant: string, excerpt: string) =>
        excerpt
          ? `…${excerpt}…`
          : occurrencesInTitle(titleContents[chapterIndex] ?? "", variant) > 0
            ? `（仅出现在第 ${chapterIndex + 1} 章标题「${titleContents[chapterIndex]}」中）`
            : "（未找到上下文）";
      return [
        `${index + 1}. 「${a}」 / 「${b}」`,
        `   「${a}」上下文：${contextFor(a ?? "", excerptA)}`,
        `   「${b}」上下文：${contextFor(b ?? "", excerptB)}`,
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
- reason 必须不超过 15 个汉字；只输出 groups，不要输出任何解释或额外字段。
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

/** Map verified conflict groups into book-wide conflicts and locate chapters.
 *  Chapter titles count as part of the chapter, so a spelling that lives only
 *  in a title still enters the conflict table and triggers the title fix. */
export function buildConflictMap(
  groups: { key: string; variants: string[] }[],
  chapterContents: string[],
  titleContents: string[] = [],
): Map<string, TerminologyConflict> {
  const conflicts = new Map<string, TerminologyConflict>();
  for (const group of groups) {
    if (!group.key) continue;
    const chapters: number[] = [];
    for (let index = 0; index < chapterContents.length; index += 1) {
      if (
        group.variants.some(
          (variant) =>
            occurrencesOutsideFences(chapterContents[index] ?? "", variant) > 0 ||
            occurrencesInTitle(titleContents[index] ?? "", variant) > 0,
        )
      ) {
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

/** Count every variant's occurrences across the book (body outside code
 *  fences, plus chapter titles). */
export function countVariantOccurrences(
  chapterContents: string[],
  conflicts: Map<string, TerminologyConflict>,
  titleContents: string[] = [],
) {
  for (const conflict of conflicts.values()) {
    let total = 0;
    for (const variant of conflict.variants) {
      for (let index = 0; index < chapterContents.length; index += 1) {
        total += occurrencesOutsideFences(chapterContents[index] ?? "", variant);
        total += occurrencesInTitle(titleContents[index] ?? "", variant);
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
  titleContents: string[] = [],
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
      chapterContents.reduce(
        (sum, content, index) =>
          sum +
          occurrencesOutsideFences(content, variant) +
          occurrencesInTitle(titleContents[index] ?? "", variant),
        0,
      ),
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

/** Title occurrences are plain string counts — no fences in a title. */
function occurrencesInTitle(title: string, token: string) {
  return title.split(token).length - 1;
}

export async function runTerminologyAudit(
  course: Course,
  options: { overrides?: ModelOverrides; request?: Request; dryRun?: boolean } = {},
): Promise<TerminologyAuditReport> {
  // Keep arrays aligned to the FULL chapter list — an empty chapter must not
  // shift the 1-based chapter numbers in the report.
  const allChapters = course.chapters;
  const fullContents = allChapters.map(
    (chapter) => chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "",
  );
  const fullTitles = allChapters.map((chapter) => chapter.title);
  const chaptersWithContent = allChapters.filter((_chapter, index) => fullContents[index]?.trim().length > 0);
  if (chaptersWithContent.length < 2) {
    return { status: "skipped", conflicts: [], rejected: [], replacements: [], appliedToChapters: [] };
  }

  try {
    // Stage 1 (deterministic, free): per-chapter gram pairing — every frequent
    // gram matched against ALL same-length grams (rare spellings included),
    // chapter titles matched against the body and ranked first — then a
    // book-level rank that puts the rare-side-first inconsistencies (the
    // 1-vs-65 signature) at the top of the judge's list. Empty chapters
    // produce no pairs but keep their index so numbering stays true.
    const chapterPairs = fullContents.map((content, index) =>
      generateChapterCandidatePairs(content, fullTitles[index]),
    );
    const candidates = rankBookCandidates(chapterPairs, fullContents);

    // Stage 2 (one LLM call): evidence-backed judge over the ranked pairs.
    const judgeRaw = await dispatchAgentText({
      agent: "REVIEWER",
      prompt: buildConflictJudgementPrompt(candidates, fullContents, fullTitles),
      temperature: 0.1,
      maxTokens: 4096,
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

    const conflicts = buildConflictMap(mergedGroups, fullContents, fullTitles);
    countVariantOccurrences(fullContents, conflicts, fullTitles);
    const { replacements, conflicts: resolved } = chooseCanonicalReplacements(
      conflicts,
      fullContents,
      course.courseBible.terminology ?? [],
      fullTitles,
    );

    if (replacements.length === 0) {
      return { status: "ok", conflicts: resolved, rejected, replacements: [], appliedToChapters: [] };
    }

    // Apply to EVERY chapter (not just chapters with content): a spelling
    // that lives only in an empty chapter's title still gets unified.
    const appliedToChapters: TerminologyAuditReport["appliedToChapters"] = [];
    for (const chapter of allChapters) {
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
