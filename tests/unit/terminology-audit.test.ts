import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTermConflicts,
  applyTerminologyReplacements,
  chooseCanonicalReplacements,
  countVariantOccurrences,
  parseChapterTermVariants,
} from "../../src/lib/maol/terminologyAudit";

test("parseChapterTermVariants merges and dedupes variant lists", () => {
  const parsed = parseChapterTermVariants(
    JSON.stringify({
      terms: [
        { english: "Markov", chinese: "马尔可夫", variants: ["马尔可夫", "马尔科夫"] },
        { english: "on-policy", chinese: "同策略", variants: ["同策略", "在策略", "on-policy"] },
        { chinese: "只有一个写法", variants: ["只有一个写法"] },
      ],
    }),
  );
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]?.variants, ["马尔可夫", "马尔科夫"]);
  assert.deepEqual(parsed[1]?.variants, ["同策略", "在策略", "on-policy"]);
});

test("parseChapterTermVariants rejects non-JSON and empty payloads", () => {
  assert.deepEqual(parseChapterTermVariants("not json"), []);
  assert.deepEqual(parseChapterTermVariants(JSON.stringify({ terms: [] })), []);
});

test("aggregateTermConflicts groups the same concept across chapters", () => {
  const conflicts = aggregateTermConflicts([
    {
      chapterIndex: 1,
      entries: [{ english: "Markov", chinese: "马尔可夫", variants: ["马尔可夫", "马尔科夫"] }],
    },
    {
      chapterIndex: 3,
      entries: [{ english: "markov", chinese: "马尔科夫", variants: ["马尔科夫"] }],
    },
    {
      chapterIndex: 2,
      entries: [{ english: "on-policy", chinese: "同策略", variants: ["同策略", "在策略"] }],
    },
  ]);
  const markov = conflicts.get("markov");
  const onPolicy = conflicts.get("on-policy");
  assert.ok(markov, "markov conflict exists");
  assert.deepEqual(markov!.variants, ["马尔可夫", "马尔科夫"]);
  assert.deepEqual(markov!.chapters, [1, 3]);
  assert.deepEqual(onPolicy?.variants, ["同策略", "在策略"]);
});

test("countVariantOccurrences and chooseCanonicalReplacements pick the most frequent form", () => {
  const conflicts = aggregateTermConflicts([
    { chapterIndex: 1, entries: [{ english: "Markov", chinese: "马尔可夫", variants: ["马尔可夫", "马尔科夫"] }] },
  ]);
  const contents = [
    "马尔可夫决策过程：马尔可夫性质很重要。",
    "马尔科夫链与马尔科夫性质。",
    "```python\n# 马尔科夫 is code, ignored\n```",
  ];
  countVariantOccurrences(contents, conflicts);
  const { replacements, conflicts: resolved } = chooseCanonicalReplacements(conflicts, contents, []);
  assert.equal(resolved.length, 1);
  assert.deepEqual(replacements, [{ from: "马尔科夫", to: "马尔可夫" }]);
});

test("Course Bible terminology overrides frequency when choosing the canonical form", () => {
  const conflicts = aggregateTermConflicts([
    { chapterIndex: 1, entries: [{ english: "Bellman", chinese: "贝尔曼", variants: ["贝尔曼", "Bellman"] }] },
  ]);
  const contents = ["Bellman Bellman Bellman 方程", "贝尔曼方程"];
  countVariantOccurrences(contents, conflicts);
  const { replacements } = chooseCanonicalReplacements(conflicts, contents, [{ term: "贝尔曼", definition: "Bellman" }]);
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
  // from is a substring of to → the pair is skipped by chooseCanonicalReplacements;
  // applyTerminologyReplacements itself only receives valid pairs.
  assert.equal(applied, 0);
  assert.equal(content, "马尔可夫链与马尔可夫。");
});
