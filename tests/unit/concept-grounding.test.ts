import assert from "node:assert/strict";
import test from "node:test";
import { buildConceptGroundingIssues, normalizeNamedConcepts, normalizeSuspectConcepts } from "../../src/lib/quality/conceptGrounding";

test("unverified suspects stay info-level (model ignorance never triggers repair)", () => {
  const issues = buildConceptGroundingIssues(
    [{ term: "随机扰动回放", note: "不认识该术语", status: "unverified" }],
    [],
  );
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]?.severity, "info");
  assert.match(issues[0]?.message ?? "", /人工核实/);
});

test("unsupported suspects stay warning-level (only class allowed to drive repair)", () => {
  const issues = buildConceptGroundingIssues(
    [{ term: "泛化偏置", note: "无文献出处", status: "unsupported" }],
    [],
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, "warning");
  assert.match(issues[0]?.message ?? "", /查无出处/);
});

test("Course Bible terms are verified and produce no grounding issue", () => {
  const issues = buildConceptGroundingIssues(
    [{ term: "重放缓冲区", note: "模型不认识", status: "unsupported" }],
    ["重放缓冲区", "优势函数"],
  );
  assert.deepEqual(issues, []);
});

test("missing status defaults to unverified, never unsupported", () => {
  const suspects = normalizeSuspectConcepts([{ term: "协同梯度", note: "可疑" }]);
  assert.equal(suspects[0]?.status, "unverified");
  assert.equal(buildConceptGroundingIssues(suspects, [])[0]?.severity, "info");
});

test("normalizeNamedConcepts dedupes, trims, and caps at 12", () => {
  const raw = [" 价值函数 ", "价值函数", "策略梯度", ...Array.from({ length: 15 }, (_, i) => `概念${i}`)];
  assert.deepEqual(normalizeNamedConcepts(raw).slice(0, 3), ["价值函数", "策略梯度", "概念0"]);
  assert.equal(normalizeNamedConcepts(raw).length, 12);
  assert.deepEqual(normalizeNamedConcepts("not an array"), []);
});

