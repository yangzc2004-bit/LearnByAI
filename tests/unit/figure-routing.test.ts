import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTextbookMapFigure, figureModeFor, parseFlowChain, stripFigurePlaceholders } from "../../src/lib/figures";
import type { Course } from "../../src/lib/types";

test("figureModeFor: user policy wins for intent-only figures", () => {
  const placeholder = { caption: "概念图", prompt: "画概念" };
  // Default: AI image when configured, code otherwise.
  assert.equal(figureModeFor(placeholder, true, undefined), "model");
  assert.equal(figureModeFor(placeholder, false, undefined), "code");
  // Explicit user choices.
  assert.equal(figureModeFor(placeholder, true, "model"), "model");
  assert.equal(figureModeFor(placeholder, true, "code"), "code");
  assert.equal(figureModeFor(placeholder, true, "off"), "off");
  // "model" without an image API degrades to code.
  assert.equal(figureModeFor(placeholder, false, "model"), "code");
});

test("figureModeFor: structured specs (diagramSpec + labels) always render as code", () => {
  const placeholder = { caption: "结构图", prompt: "画流程", diagramSpec: "A -> B", textLabelsAllowed: true };
  // Even with an image model configured — and even under an explicit "model"
  // course preference — structure figures stay programmatic SVG.
  assert.equal(figureModeFor(placeholder, true, undefined), "code");
  assert.equal(figureModeFor(placeholder, true, "model"), "code");
  assert.equal(figureModeFor(placeholder, false, undefined), "code");
  assert.equal(figureModeFor(placeholder, true, "code"), "code");
  assert.equal(figureModeFor(placeholder, true, "off"), "off");
  // diagramSpec WITHOUT label allowance still follows the model preference.
  assert.equal(figureModeFor({ caption: "结构图", prompt: "画流程", diagramSpec: "A -> B" }, true, undefined), "model");
});

test("createTextbookMapFigure keeps the structure map on programmatic SVG even with an image API", async () => {
  // The textbook map carries chapter titles + numbering as a structured spec:
  // a configured image model must NOT get it (models garble numbers/titles).
  const previousKey = process.env.ILLUSTRATION_API_KEY;
  process.env.ILLUSTRATION_API_KEY = "test-image-key";
  try {
    const course = {
      id: "course-map",
      topic: "强化学习",
      chapters: [
        { id: "c1", title: "策略梯度" },
        { id: "c2", title: "演员-评论家方法" },
      ],
    } as unknown as Course;
    const asset = await createTextbookMapFigure(course);
    assert.equal(asset.generationMode, "code");
    assert.equal(asset.textLabelsAllowed, true);
    assert.equal(asset.chapterId, "book-map");
  } finally {
    if (previousKey === undefined) delete process.env.ILLUSTRATION_API_KEY;
    else process.env.ILLUSTRATION_API_KEY = previousKey;
  }
});

test("createTextbookMapFigure routes through figureModeFor, not a raw model ternary", () => {
  const src = readFileSync("src/lib/figures.ts", "utf8");
  const start = src.indexOf("export async function createTextbookMapFigure");
  const end = src.indexOf("export async function regenerateChapterFigure");
  const body = src.slice(start, end);
  assert.match(body, /diagramSpec: chapterNames/u);
  assert.match(body, /textLabelsAllowed: true/u);
  assert.match(body, /figureModeFor\(placeholder, Boolean\(getUserImageModelConfig\(overrides\)\), course\.figureMode\)/u);
  assert.doesNotMatch(body, /getUserImageModelConfig\(overrides\) \? "model" : "code"/u);
});

test("stripFigurePlaceholders removes placeholder blocks cleanly", () => {
  const content = [
    "正文第一段。",
    "",
    ":::learnbyai-figure",
    "caption: 流程",
    "prompt: 画流程",
    "diagramSpec: A -> B",
    ":::",
    "",
    "正文第二段。",
  ].join("\n");
  const stripped = stripFigurePlaceholders(content);
  assert.ok(stripped.includes("正文第一段。"), stripped);
  assert.ok(stripped.includes("正文第二段。"), stripped);
  assert.ok(!stripped.includes("learnbyai-figure"), stripped);
  assert.ok(!stripped.includes("diagramSpec"), stripped);
});

test("parseFlowChain parses arrow chains and rejects free text", () => {
  assert.deepEqual(parseFlowChain("策略评估 -> 策略改进 -> 收敛（检查条件）"), ["策略评估", "策略改进", "收敛"]);
  assert.deepEqual(parseFlowChain("观察 → 更新 → 输出"), ["观察", "更新", "输出"]);
  assert.equal(parseFlowChain("只有一个节点"), undefined);
  assert.equal(parseFlowChain(undefined), undefined);
  // Chains longer than 6 nodes are capped.
  assert.equal(parseFlowChain("节点甲 -> 节点乙 -> 节点丙 -> 节点丁 -> 节点戊 -> 节点己 -> 节点庚")?.length, 6);
});
