import assert from "node:assert/strict";
import test from "node:test";
import {
  applySkeletonTitleReviews,
  buildSkeletonTitleReviewPrompt,
  parseSkeletonTitleReviews,
  stripYearTagFromTitle,
} from "../../src/lib/titleReview";
import type { CourseSkeleton } from "../../src/lib/prompts/coursePlanner";

function skeleton(titles: string[]): CourseSkeleton {
  return {
    profile: "测试路线",
    chapters: titles.map((title) => ({
      title,
      description: `${title}的概述`,
      purpose: `讲透${title}`,
      connectionFromPrevious: "承接上一章。",
      setupForNext: "为下一章铺垫。",
      depth: "normal",
      time: { readingMinutes: 60, exerciseMinutes: 30, practiceMinutes: 30, extensionMinutes: 15 },
    })),
  };
}

test("stripYearTagFromTitle removes trailing year tags", () => {
  assert.equal(stripYearTagFromTitle("迈向耦合系统（2024）"), "迈向耦合系统");
  assert.equal(stripYearTagFromTitle("代理最优控制算法(2025年)"), "代理最优控制算法");
  assert.equal(stripYearTagFromTitle("无年份标题"), "无年份标题");
  assert.equal(stripYearTagFromTitle("  策略梯度  "), "策略梯度");
});

test("parseSkeletonTitleReviews parses and sanitizes review JSON", () => {
  const reviews = parseSkeletonTitleReviews(
    JSON.stringify({
      titles: [
        { index: 2, title: "基于函数逼近的预测", reason: "与内容匹配" },
        { index: 5, title: "迈向耦合系统", reason: "去除年份" },
        { index: 0, title: "越界" },
        { title: "缺序号" },
      ],
    }),
  );
  assert.deepEqual(reviews, [
    { index: 2, title: "基于函数逼近的预测", reason: "与内容匹配" },
    { index: 5, title: "迈向耦合系统", reason: "去除年份" },
  ]);
  assert.deepEqual(parseSkeletonTitleReviews("not json"), []);
});

test("applySkeletonTitleReviews applies safe revisions only", () => {
  const result = applySkeletonTitleReviews(skeleton(["引言", "基于策略的预测", "迈向耦合系统（2024）", "总结与展望"]), [
    { index: 2, title: "基于函数逼近的预测" },
    { index: 3, title: "迈向耦合系统" },
    { index: 1, title: "引言改名" },
    { index: 4, title: "总结改名" },
    { index: 9, title: "越界" },
    { index: 2, title: "迈向耦合系统" }, // duplicate of chapter 3's new title
  ]);
  assert.equal(result.changed, 2);
  assert.deepEqual(
    result.skeleton.chapters.map((chapter) => chapter.title),
    ["引言", "基于函数逼近的预测", "迈向耦合系统", "总结与展望"],
  );
  assert.equal(result.rejected.length, 4, JSON.stringify(result.rejected));
});

test("buildSkeletonTitleReviewPrompt embeds the chapter route and forbids fixed-chapter edits", () => {
  const input = {
    topic: "强化学习",
    goal: "掌握核心算法",
    background: "有基础",
    styles: [],
    learningMode: "guided" as const,
    chapterCount: 4,
    difficulty: "intermediate" as const,
  };
  const prompt = buildSkeletonTitleReviewPrompt(input, skeleton(["引言", "基于策略的预测", "策略梯度", "总结与展望"]));
  assert.ok(prompt.includes("基于策略的预测"), prompt);
  assert.ok(prompt.includes("第一章与最后一章"), prompt);
  assert.ok(prompt.includes("不得含年份"), prompt);
});
