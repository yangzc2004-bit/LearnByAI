import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertChapterPositionRequirements,
  extractChapterPositionRequirements,
} from "../../src/lib/courseRequirementConstraints";

const requirements = [
  "第6章“空间生态学与元种群动态”末尾增加计算生态学过渡。",
  "第7章“控制论视角的生态系统”开篇说明可调控系统框架。",
  "第8章“基于智能体的生态建模（ABM）”强调局部规则涌现。",
].join("\n");

test("extracts Arabic and Chinese chapter position requirements", () => {
  assert.deepEqual(
    extractChapterPositionRequirements(
      "第六章「空间生态学」；第7章“控制论视角的生态系统”。",
    ).map((item) => [item.chapterNumber, item.expectedTitle]),
    [
      [6, "空间生态学"],
      [7, "控制论视角的生态系统"],
    ],
  );
});

test("accepts semantically aligned chapter titles at required positions", () => {
  const chapters = Array.from({ length: 8 }, (_, index) => ({
    title: `占位章节 ${index + 1}`,
  }));
  chapters[5] = { title: "空间生态学与空间动态模型" };
  chapters[6] = { title: "控制论视角下的生态系统" };
  chapters[7] = { title: "基于智能体的生态建模（ABM）" };

  assert.doesNotThrow(() =>
    assertChapterPositionRequirements(chapters, requirements),
  );
});

test("rejects a skeleton that shifts control theory and ABM to the wrong chapters", () => {
  const chapters = Array.from({ length: 8 }, (_, index) => ({
    title: `占位章节 ${index + 1}`,
  }));
  chapters[5] = { title: "空间生态学与空间动态模型" };
  chapters[6] = { title: "基于智能体的模型（ABM）" };
  chapters[7] = { title: "控制ABM：代理模型与最优控制" };

  assert.throws(
    () => assertChapterPositionRequirements(chapters, requirements),
    /第 7 章必须对应“控制论视角的生态系统”/u,
  );
});
