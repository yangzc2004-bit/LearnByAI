import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTerminologyReplacements,
  applyTerminologyReplacementsToString,
  buildConflictMap,
  chooseCanonicalReplacements,
  countVariantOccurrences,
  excerptAround,
  extractCjkNgrams,
  filterCoOccurringPairs,
  findNearDuplicatePairs,
  mergeTransitiveGroups,
  parseConflictGroups,
  rankCandidatePairs,
} from "../../src/lib/maol/terminologyAudit";

test("extractCjkNgrams keeps only grams appearing at least twice", () => {
  const grams = extractCjkNgrams("马尔可夫决策过程与马尔可夫性质。偶尔出现的唯一词。");
  assert.ok(grams.includes("马尔可夫"), JSON.stringify(grams));
  assert.ok(!grams.includes("偶尔出现"), JSON.stringify(grams));
});

test("extractCjkNgrams suppresses sub-word fragments of longer grams", () => {
  const grams = extractCjkNgrams("价值函数的价值函数。状态价值是核心。状态价值很关键。");
  assert.ok(!grams.includes("价值函"), JSON.stringify(grams));
  assert.ok(!grams.includes("状态价"), JSON.stringify(grams));
  assert.ok(grams.includes("价值函数"), JSON.stringify(grams));
  // 状态价值 appears standalone (not only inside longer grams), so it stays.
  assert.ok(grams.includes("状态价值"), JSON.stringify(grams));
});

test("findNearDuplicatePairs seeds same-length one-character-difference pairs", () => {
  const pairs = findNearDuplicatePairs(["马尔可夫", "马尔科夫", "回放缓冲区", "重放缓冲区", "价值迭代", "策略迭代", "蒙特卡洛"]);
  const flat = pairs.map((pair) => pair.variants.sort().join("/")).sort();
  assert.ok(flat.includes("马尔可夫/马尔科夫"), JSON.stringify(flat));
  assert.ok(flat.includes("回放缓冲区/重放缓冲区"), JSON.stringify(flat));
  assert.ok(!flat.some((pair) => pair.includes("价值迭代") && pair.includes("策略迭代")), JSON.stringify(flat));
});

test("filterCoOccurringPairs keeps only pairs whose variants share a chapter", () => {
  const contents = [
    "本章讨论马尔可夫决策过程，其中马尔科夫链被反复使用。",
    "本章只有重放缓冲区方法，另一章才有回放缓冲区。",
    "回放缓冲区与重放缓冲区同时出现在这一章。",
  ];
  const pairs = filterCoOccurringPairs(
    [
      { variants: ["马尔可夫", "马尔科夫"] },
      { variants: ["回放缓冲区", "重放缓冲区"] },
    ],
    contents,
  );
  assert.equal(pairs.length, 2, JSON.stringify(pairs));
});

test("rankCandidatePairs puts frequency-imbalanced pairs first", () => {
  const contents = [
    "马尔可夫 ".repeat(30) + "马尔科夫",
    "回放缓冲区 ".repeat(10) + "重放缓冲区 ".repeat(9),
    "状态价值 ".repeat(20) + "动作价值 ".repeat(20),
  ];
  const ranked = rankCandidatePairs(
    [
      { variants: ["回放缓冲区", "重放缓冲区"] },
      { variants: ["状态价值", "动作价值"] },
      { variants: ["马尔可夫", "马尔科夫"] },
    ],
    contents,
  );
  assert.deepEqual(ranked[0]?.variants, ["马尔可夫", "马尔科夫"], JSON.stringify(ranked));
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
