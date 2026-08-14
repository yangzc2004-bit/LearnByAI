import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTerminologyReplacements,
  applyTerminologyReplacementsToString,
  buildConflictJudgementPrompt,
  buildConflictMap,
  chooseCanonicalReplacements,
  countVariantOccurrences,
  excerptAround,
  extractCjkGrams,
  generateChapterCandidatePairs,
  mergeTransitiveGroups,
  parseConflictGroups,
  rankBookCandidates,
} from "../../src/lib/maol/terminologyAudit";

test("extractCjkGrams builds a full count map with 4-8 char windows", () => {
  const grams = extractCjkGrams("马尔可夫决策过程与马尔可夫性质。");
  assert.equal(grams.get("马尔可夫"), 2, JSON.stringify([...grams.entries()]));
  assert.equal(grams.get("马尔可夫决策过程"), 1);
});

test("generateChapterCandidatePairs pairs a frequent gram with a rare one-char-diff spelling", () => {
  const content = "马尔可夫决策过程与马尔可夫性质。马尔科夫决策过程仅出现一次。".repeat(2);
  const pairs = generateChapterCandidatePairs(content);
  const flat = pairs.map((pair) => pair.variants.sort().join("/"));
  assert.ok(flat.includes("马尔可夫/马尔科夫"), JSON.stringify(flat));
  assert.ok(flat.includes("马尔可夫决策过程/马尔科夫决策过程"), JSON.stringify(flat));
});

test("generateChapterCandidatePairs boosts title-vs-body spelling splits", () => {
  const content = "马尔可夫决策过程与马尔可夫性质。".repeat(4);
  const pairs = generateChapterCandidatePairs(content, "马尔科夫决策过程");
  const flat = pairs.map((pair) => pair.variants.sort().join("/"));
  assert.ok(flat.includes("马尔可夫决策过程/马尔科夫决策过程"), JSON.stringify(flat));
  assert.equal(pairs[0]?.title, true, JSON.stringify(pairs.slice(0, 3)));
});

test("rankBookCandidates ranks title conflicts and rare-side pairs first", () => {
  const content = "同义甲 同义乙 ".repeat(20) + "马尔可夫决策过程 ".repeat(28) + "马尔科夫决策过程 " + "马尔可夫 ".repeat(64) + "马尔科夫";
  const ranked = rankBookCandidates(
    [
      [{ variants: ["同义甲", "同义乙"], rare: 20, imbalance: 3, total: 43, title: false }],
      [{ variants: ["马尔可夫", "马尔科夫"], rare: 1, imbalance: 64, total: 65, title: false }],
      [{ variants: ["马尔可夫决策过程", "马尔科夫决策过程"], rare: 1, imbalance: 28, total: 29, title: true }],
    ],
    [content],
  );
  assert.deepEqual(ranked[0]?.variants, ["马尔可夫决策过程", "马尔科夫决策过程"], JSON.stringify(ranked));
  assert.deepEqual(ranked[1]?.variants, ["马尔可夫", "马尔科夫"], JSON.stringify(ranked));
});

test("excerptAround returns a short real context around the token", () => {
  const content = "前言部分文字。这里是马尔科夫决策过程的定义段落，随后继续。";
  const excerpt = excerptAround(content, "马尔科夫", 20);
  assert.ok(excerpt.includes("马尔科夫"), excerpt);
  assert.ok(excerpt.length <= 20 + 3 + 20 + 6, excerpt);
});

test("parseConflictGroups parses evidence-judge decisions", () => {
  const groups = parseConflictGroups(
    JSON.stringify({
      groups: [
        { variants: ["马尔可夫", "马尔科夫"], same: true, reason: "同为 Markov 译名" },
        { variants: ["硬更新", "软更新"], same: false, reason: "反义词" },
        { variants: ["单一写法"], same: true },
      ],
    }),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { key: "马尔可夫\u0000马尔科夫", variants: ["马尔可夫", "马尔科夫"], same: true, reason: "同为 Markov 译名" });
  assert.equal(groups[1]?.same, false);
});

test("parseConflictGroups rejects non-JSON", () => {
  assert.deepEqual(parseConflictGroups("not json"), []);
});

test("mergeTransitiveGroups unions groups that share a spelling", () => {
  const merged = mergeTransitiveGroups([
    { key: "a", variants: ["多步回报", "n步回报"] },
    { key: "b", variants: ["n步回报", "n步回溯"] },
    { key: "c", variants: ["马尔可夫", "马尔科夫"] },
  ]);
  const byKey = merged.map((group) => group.variants.sort().join("/")).sort();
  assert.deepEqual(byKey, ["n步回报/n步回溯/多步回报", "马尔可夫/马尔科夫"]);
});

test("buildConflictMap locates chapters and countVariantOccurrences counts outside fences", () => {
  const contents = [
    "马尔可夫决策过程：马尔可夫性质很重要。",
    "马尔科夫链与马尔科夫性质。",
    "```python\n# 马尔科夫 is code, ignored\n```",
  ];
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    contents,
  );
  const markov = conflicts.get("a");
  assert.ok(markov);
  assert.deepEqual(markov!.chapters, [1, 2]);
  countVariantOccurrences(contents, conflicts);
  assert.equal(markov!.occurrences, 4);
});

test("buildConflictMap keeps chapters that only carry the spelling in the TITLE", () => {
  // 马尔科夫 appears only in chapter 2's title, nowhere in any body.
  const contents = ["正文只写马尔可夫。", "正文也只写马尔可夫。"];
  const titles = ["引言", "马尔科夫决策过程"];
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    contents,
    titles,
  );
  const markov = conflicts.get("a");
  assert.ok(markov, JSON.stringify([...conflicts.keys()]));
  assert.deepEqual(markov!.chapters, [1, 2]);
});

test("countVariantOccurrences counts title occurrences too", () => {
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    ["马尔可夫 马尔可夫", ""],
    ["", "马尔科夫决策过程"],
  );
  countVariantOccurrences(["马尔可夫 马尔可夫", ""], conflicts, ["", "马尔科夫决策过程"]);
  assert.equal(conflicts.get("a")?.occurrences, 3);
});

test("chooseCanonicalReplacements replaces a title-only spelling with the body form", () => {
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    ["马尔可夫 马尔可夫 马尔可夫", ""],
    ["", "马尔科夫决策过程"],
  );
  const { replacements } = chooseCanonicalReplacements(
    conflicts,
    ["马尔可夫 马尔可夫 马尔可夫", ""],
    [],
    ["", "马尔科夫决策过程"],
  );
  assert.deepEqual(replacements, [{ from: "马尔科夫", to: "马尔可夫" }]);
});

test("buildConflictMap numbers chapters by the FULL list, not the filtered one", () => {
  // Real chapter 2 has no content; the conflict lives in real chapter 3.
  const contents = ["第一章正文。", "", "第三章：马尔可夫与马尔科夫并存。"];
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    contents,
  );
  assert.deepEqual(conflicts.get("a")?.chapters, [3]);
});

test("buildConflictJudgementPrompt labels title-only spellings with their chapter", () => {
  const prompt = buildConflictJudgementPrompt(
    [{ variants: ["马尔可夫", "马尔科夫"] }],
    ["正文只写马尔可夫。"],
    ["马尔科夫决策过程"],
  );
  assert.ok(prompt.includes("仅出现在第 1 章标题「马尔科夫决策过程」中"), prompt);
});

test("chooseCanonicalReplacements picks the most frequent form and drops non-CJK pairs", () => {
  const conflicts = buildConflictMap(
    [
      { key: "markov", variants: ["马尔可夫", "马尔科夫"] },
      { key: "acronyms", variants: ["GRPO", "TRPO"] },
    ],
    ["马尔可夫 马尔可夫 马尔可夫", "马尔科夫 GRPO TRPO"],
  );
  const { replacements, conflicts: resolved } = chooseCanonicalReplacements(
    conflicts,
    ["马尔可夫 马尔可夫 马尔可夫", "马尔科夫 GRPO TRPO"],
    [],
  );
  assert.equal(resolved.length, 1, JSON.stringify(resolved));
  assert.deepEqual(replacements, [{ from: "马尔科夫", to: "马尔可夫" }]);
});

test("Course Bible terminology overrides frequency when choosing the canonical form", () => {
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["回放缓冲区", "重放缓冲区"] }],
    ["回放缓冲区 回放缓冲区 回放缓冲区", "重放缓冲区"],
  );
  const { replacements } = chooseCanonicalReplacements(
    conflicts,
    ["回放缓冲区 回放缓冲区 回放缓冲区", "重放缓冲区"],
    [{ term: "重放缓冲区", definition: "replay buffer" }],
  );
  assert.deepEqual(replacements, [{ from: "回放缓冲区", to: "重放缓冲区" }]);
});

test("chooseCanonicalReplacements lets the body win a title-vs-body tie (马尔科夫/马尔可夫 regression)", () => {
  // One body occurrence of 马尔可夫, one title occurrence of 马尔科夫. The
  // variants are ordered title-first, exactly as the candidate generator
  // produces them — the canonical choice must NOT depend on that order.
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔科夫", "马尔可夫"] }],
    ["正文只写马尔可夫。", ""],
    ["", "马尔科夫决策过程"],
  );
  const { replacements } = chooseCanonicalReplacements(
    conflicts,
    ["正文只写马尔可夫。", ""],
    [],
    ["", "马尔科夫决策过程"],
  );
  assert.deepEqual(replacements, [{ from: "马尔科夫", to: "马尔可夫" }]);
});

test("chooseCanonicalReplacements uses the title count only to break a body tie", () => {
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    ["马尔可夫 马尔科夫", ""],
    ["", "马尔科夫决策过程"],
  );
  const { replacements } = chooseCanonicalReplacements(
    conflicts,
    ["马尔可夫 马尔科夫", ""],
    [],
    ["", "马尔科夫决策过程"],
  );
  assert.deepEqual(replacements, [{ from: "马尔可夫", to: "马尔科夫" }]);
});

test("chooseCanonicalReplacements stays conservative on a full body+title tie", () => {
  const conflicts = buildConflictMap(
    [{ key: "a", variants: ["马尔可夫", "马尔科夫"] }],
    ["马尔可夫 马尔科夫", ""],
  );
  const { replacements, conflicts: resolved } = chooseCanonicalReplacements(
    conflicts,
    ["马尔可夫 马尔科夫", ""],
    [],
  );
  assert.equal(resolved.length, 1, JSON.stringify(resolved));
  assert.deepEqual(replacements, []);
});


test("applyTerminologyReplacements skips fenced code blocks", () => {
  const md = [
    "正文：马尔科夫链与马尔科夫性质。",
    "```python",
    "# 马尔科夫 must stay as-is in code",
    "```",
    "又一处马尔科夫。",
  ].join("\n");
  const { content, applied } = applyTerminologyReplacements(md, [{ from: "马尔科夫", to: "马尔可夫" }]);
  assert.equal(applied, 3);
  assert.equal(content.split("马尔可夫").length - 1, 3, content);
  assert.ok(content.includes("# 马尔科夫 must stay as-is in code"), content);
});

test("applyTerminologyReplacements refuses substring corruption", () => {
  const { content, applied } = applyTerminologyReplacements("马尔可夫链与马尔可夫。", [
    { from: "马尔可夫", to: "马尔可夫链" },
  ]);
  assert.equal(applied, 0);
  assert.equal(content, "马尔可夫链与马尔可夫。");
});

test("applyTerminologyReplacementsToString rewrites plain strings (chapter titles)", () => {
  assert.equal(
    applyTerminologyReplacementsToString("马尔科夫决策过程", [{ from: "马尔科夫", to: "马尔可夫" }]),
    "马尔可夫决策过程",
  );
});
