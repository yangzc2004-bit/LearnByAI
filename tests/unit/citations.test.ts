import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSectionIndex, extractCitations } from "../../src/lib/citations";
import type { Section } from "../../src/lib/types";

function makeSection(id: string, order: number): Section {
  return {
    id,
    chapterId: "chapter-1",
    title: `第${order}节`,
    purpose: "测试目的",
    content: `正文 ${order}`,
    status: "ready",
    order,
  };
}

test("buildSectionIndex labels sections 1-based by order", () => {
  const index = buildSectionIndex([
    makeSection("a", 2),
    makeSection("b", 0),
    makeSection("c", 1),
  ]);

  assert.equal(index.get("§1"), "b");
  assert.equal(index.get("§2"), "c");
  assert.equal(index.get("§3"), "a");
});

test("extractCitations returns ordered, deduped, valid citations", () => {
  const index = new Map<string, string>([
    ["§1", "s1"],
    ["§2", "s2"],
  ]);

  const citations = extractCitations("见 [§2] 与 [§1]，再次 [§2]，无效 [§9]。", index);
  assert.deepEqual(citations, [
    { sectionId: "s2", label: "§2" },
    { sectionId: "s1", label: "§1" },
  ]);
});

test("extractCitations drops labels missing from the section index", () => {
  const index = new Map<string, string>([["§1", "s1"]]);
  assert.deepEqual(extractCitations("只有 [§5] 和 [§1]", index), [
    { sectionId: "s1", label: "§1" },
  ]);
});

test("extractCitations ignores non-marker brackets and empty input", () => {
  const index = new Map<string, string>([["§1", "s1"]]);
  assert.deepEqual(extractCitations("", index), []);
  assert.deepEqual(extractCitations("普通 [引用] 与 [§1.2] 都不算", index), []);
});
