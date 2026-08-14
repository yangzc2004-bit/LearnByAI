import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTerminologyReplacements,
  buildConflictMap,
  chooseCanonicalReplacements,
  countVariantOccurrences,
  findNearDuplicatePairs,
  parseChapterTerms,
  parseConflictGroups,
} from "../../src/lib/maol/terminologyAudit";

test("parseChapterTerms extracts, dedupes and caps term lists", () => {
  const parsed = parseChapterTerms(
    JSON.stringify({ terms: ["马尔可夫", "马尔科夫", "Q 学习", "马尔可夫", "", "a", "太长太长太长太长太长太长"] }),
  );
  assert.deepEqual(parsed, ["马尔可夫", "马尔科夫", "Q 学习", "太长太长太长太长太长"]);
});

test("parseChapterTerms rejects non-JSON and empty payloads", () => {
  assert.deepEqual(parseChapterTerms("not json"), []);
  assert.deepEqual(parseChapterTerms(JSON.stringify({ terms: [] })), []);
});

test("findNearDuplicatePairs seeds same-length one-character-difference pairs", () => {
  const pairs = findNearDuplicatePairs(["马尔可夫", "马尔科夫", "同策略", "在策略", "价值迭代", "策略迭代", "蒙特卡洛"]);
  const flat = pairs.map((pair) => pair.variants.sort().join("/")).sort();
  assert.ok(flat.includes("马尔可夫/马尔科夫"), JSON.stringify(flat));
  assert.ok(flat.includes("同策略/在策略"), JSON.stringify(flat));
  // Two-character differences are NOT seeds (价值迭代 vs 策略迭代 differ in 2 positions).
  assert.ok(!flat.some((pair) => pair.includes("价值迭代") && pair.includes("策略迭代")), JSON.stringify(flat));
});

test("parseConflictGroups parses the judge output and skips single-variant groups", () => {
  const groups = parseConflictGroups(
    JSON.stringify({
      conflicts: [
        { english: "Markov", variants: ["马尔可夫", "马尔科夫"] },
        { english: "on-policy", variants: ["同策略", "在策略"] },
        { variants: ["单一写法"] },
      ],
    }),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { key: "markov", english: "Markov", variants: ["马尔可夫", "马尔科夫"] });
  assert.deepEqual(groups[1], { key: "on-policy", english: "on-policy", variants: ["同策略", "在策略"] });
});

test("parseConflictGroups rejects non-JSON", () => {
  assert.deepEqual(parseConflictGroups("not json"), []);
});

test("buildConflictMap locates chapters and countVariantOccurrences counts outside fences", () => {
  const contents = [
    "马尔可夫决策过程：马尔可夫性质很重要。",
    "马尔科夫链与马尔科夫性质。",
    "```python\n# 马尔科夫 is code, ignored\n```",
  ];
  const conflicts = buildConflictMap(
    [{ key: "markov", variants: ["马尔可夫", "马尔科夫"] }],
    contents,
  );
  const markov = conflicts.get("markov");
  assert.ok(markov);
  assert.deepEqual(markov!.chapters, [1, 2]);
  countVariantOccurrences(contents, conflicts);
  assert.equal(markov!.occurrences, 4);
});

test("chooseCanonicalReplacements picks the most frequent form", () => {
  const conflicts = buildConflictMap(
    [{ key: "markov", variants: ["马尔可夫", "马尔科夫"] }],
    ["马尔可夫 马尔可夫 马尔可夫", "马尔科夫"],
  );
  const { replacements, conflicts: resolved } = chooseCanonicalReplacements(conflicts, ["马尔可夫 马尔可夫 马尔可夫", "马尔科夫"], []);
  assert.equal(resolved.length, 1);
  assert.deepEqual(replacements, [{ from: "马尔科夫", to: "马尔可夫" }]);
});

test("Course Bible terminology overrides frequency when choosing the canonical form", () => {
  const conflicts = buildConflictMap(
    [{ key: "bellman", variants: ["贝尔曼", "Bellman"] }],
    ["Bellman Bellman Bellman 方程", "贝尔曼方程"],
  );
  const { replacements } = chooseCanonicalReplacements(
    conflicts,
    ["Bellman Bellman Bellman 方程", "贝尔曼方程"],
    [{ term: "贝尔曼", definition: "Bellman" }],
  );
  assert.deepEqual(replacements, [{ from: "Bellman", to: "贝尔曼" }]);
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
  // "马尔可夫" must not be a substring of the canonical "马尔可夫链".
  const { content, applied } = applyTerminologyReplacements("马尔可夫链与马尔可夫。", [
    { from: "马尔可夫", to: "马尔可夫链" },
  ]);
  assert.equal(applied, 0);
  assert.equal(content, "马尔可夫链与马尔可夫。");
});
