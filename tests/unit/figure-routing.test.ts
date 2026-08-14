import assert from "node:assert/strict";
import test from "node:test";
import { figureModeFor, parseFlowChain, stripFigurePlaceholders } from "../../src/lib/figures";

test("figureModeFor: user policy wins, default prefers the image model", () => {
  const placeholder = { caption: "结构图", prompt: "画流程", diagramSpec: "A -> B", textLabelsAllowed: true };
  // Default: AI image when configured — unified style everywhere.
  assert.equal(figureModeFor(placeholder, true, undefined), "model");
  assert.equal(figureModeFor(placeholder, false, undefined), "code");
  // Explicit user choices.
  assert.equal(figureModeFor(placeholder, true, "model"), "model");
  assert.equal(figureModeFor(placeholder, true, "code"), "code");
  assert.equal(figureModeFor(placeholder, true, "off"), "off");
  // "model" without an image API degrades to code.
  assert.equal(figureModeFor(placeholder, false, "model"), "code");
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
