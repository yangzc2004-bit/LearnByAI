import assert from "node:assert/strict";
import test from "node:test";
import { figureModeFor, parseFlowChain } from "../../src/lib/figures";

test("figureModeFor routes labeled structured diagrams to code rendering", () => {
  const structured = { caption: "流程", prompt: "画流程", diagramSpec: "A -> B -> C", textLabelsAllowed: true };
  assert.equal(figureModeFor(structured, true), "code");
  // No image model configured → everything falls back to code.
  assert.equal(figureModeFor({ caption: "意向图", prompt: "概念插画" }, false), "code");
  // Labels explicitly disallowed → intent illustration → image model.
  assert.equal(
    figureModeFor({ caption: "意向图", prompt: "概念插画", textLabelsAllowed: false }, true),
    "model",
  );
  // No diagramSpec → intent illustration → image model.
  assert.equal(figureModeFor({ caption: "意向图", prompt: "概念插画" }, true), "model");
});

test("parseFlowChain parses arrow chains and rejects free text", () => {
  assert.deepEqual(parseFlowChain("策略评估 -> 策略改进 -> 收敛（检查条件）"), ["策略评估", "策略改进", "收敛"]);
  assert.deepEqual(parseFlowChain("观察 → 更新 → 输出"), ["观察", "更新", "输出"]);
  assert.equal(parseFlowChain("只有一个节点"), undefined);
  assert.equal(parseFlowChain(undefined), undefined);
  // Chains longer than 6 nodes are capped.
  assert.equal(parseFlowChain("节点甲 -> 节点乙 -> 节点丙 -> 节点丁 -> 节点戊 -> 节点己 -> 节点庚")?.length, 6);
});
