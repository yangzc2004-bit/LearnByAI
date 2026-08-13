import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHarnessContractFingerprint,
  buildChapterHarnessStages,
  isMissingContextRefusal,
  normalizeHarnessStageOutput,
  readValidHarnessCheckpoint,
} from "../../src/lib/maol/chapterAuthorHarness";
import { Chapter, ChapterHarnessCheckpoint, Course } from "../../src/lib/types";

function fixture() {
  const chapter: Chapter = {
    id: "chapter-2",
    title: "种群动态模型",
    description: "种群增长与密度制约",
    purpose: "建立种群动态模型",
    connectionFromPrevious: "承接生态学基础",
    setupForNext: "铺垫种间相互作用",
    depthWeight: "core",
    time: {
      readingMinutes: 120,
      exerciseMinutes: 60,
      practiceMinutes: 60,
      extensionMinutes: 30,
    },
    contract: {
      chapterTitle: "种群动态模型",
      requiredTopics: ["指数增长", "逻辑斯蒂增长"],
      bridgeFromPrevious: "承接基础概念",
      bridgeToNext: "引出种间作用",
      forbiddenEarlyTopics: ["群落网络"],
      requiredExamples: ["种群增长实例"],
      requiredFormulas: ["增长方程"],
    },
  };
  const course: Course = {
    id: "course",
    contentMode: "textbook",
    topic: "理论生态学",
    goal: "形成系统教材",
    background: "具备微积分基础",
    styles: [],
    learningMode: "systematic",
    chapterCount: 3,
    difficulty: "research",
    profile: "系统学习",
    courseBible: {
      targetLearner: "研究生",
      finalOutcomes: [],
      teachingStyle: "教材",
      prerequisites: [],
      globalNarrative: "从个体到系统",
      terminology: [],
      chapterDependencies: [],
      chapterContracts: [chapter.contract!],
    },
    textbookMeta: {
      title: "理论生态学",
      language: "zh-CN",
      outlineStatus: "confirmed",
      outline: {
        chapters: [{
          id: chapter.id,
          title: chapter.title,
          description: chapter.description,
          order: 0,
          sections: [
            { id: "s1", title: "2.1 指数增长", description: "", order: 0 },
            { id: "s2", title: "逻辑斯蒂增长", description: "", order: 1 },
          ],
        }],
      },
    },
    chapters: [chapter],
    createdAt: new Date(0).toISOString(),
  };
  return { course, chapter };
}

test("chapter author harness follows the confirmed textbook section ledger", () => {
  const { course, chapter } = fixture();
  const stages = buildChapterHarnessStages(course, chapter, 0);

  assert.deepEqual(
    stages.map((stage) => ({ heading: stage.heading, kind: stage.kind })),
    [
      { heading: "1.1 指数增长", kind: "body" },
      { heading: "1.2 逻辑斯蒂增长", kind: "body" },
      { heading: undefined, kind: "closing" },
    ],
  );
});

test("fixed introduction and conclusion chapters remain unsectioned", () => {
  const { course, chapter } = fixture();
  course.textbookMeta!.outline!.chapters[0]!.fixedRole = "introduction";
  const stages = buildChapterHarnessStages(course, chapter, 0);

  assert.equal(stages.length, 2);
  assert.equal(stages[0]?.heading, undefined);
  assert.equal(stages[0]?.kind, "body");
  assert.equal(stages[1]?.kind, "closing");
});

test("chapter author harness rejects provider context-loss refusals", () => {
  assert.equal(
    isMissingContextRefusal(
      "I don't have the previous answer content, so I can't continue it.",
    ),
    true,
  );
  assert.equal(
    isMissingContextRefusal(
      "This section continues the population dynamics derivation from the completed stage.",
    ),
    false,
  );
});

test("chapter author harness removes only a duplicated leading chapter heading from later stages", () => {
  assert.equal(
    normalizeHarnessStageOutput(
      "# 第二章：种群动态模型\n\n## 2.4 密度制约\n\n正文。",
      3,
    ),
    "## 2.4 密度制约\n\n正文。",
  );
  assert.equal(
    normalizeHarnessStageOutput(
      "## 2.4 密度制约\n\n正文。",
      3,
    ),
    "## 2.4 密度制约\n\n正文。",
  );
  assert.equal(
    normalizeHarnessStageOutput(
      "# 第二章：种群动态模型\n\n## 2.1 指数增长\n\n正文。",
      0,
    ),
    "# 第二章：种群动态模型\n\n## 2.1 指数增长\n\n正文。",
  );
  assert.equal(
    normalizeHarnessStageOutput(
      "# 2. 生态学基础概念与系统思维\n\n## 2.5 复杂性\n\n正文。",
      4,
    ),
    "## 2.5 复杂性\n\n正文。",
  );
});

test("chapter author harness restores only validated stages bound to the same contract", () => {
  const { course, chapter } = fixture();
  const stages = buildChapterHarnessStages(course, chapter, 0);
  const masterContract = "immutable course bible and chapter contract";
  const fingerprint = buildHarnessContractFingerprint(masterContract, chapter.id, stages);
  const checkpoint: ChapterHarnessCheckpoint = {
    version: 1,
    chapterId: chapter.id,
    contractFingerprint: fingerprint,
    stageIds: stages.map((stage) => stage.id),
    completedStages: [{
      id: stages[0]!.id,
      content: `# chapter\n\n## ${stages[0]!.heading}\n\nValidated first-stage content.`,
    }],
    updatedAt: new Date(0).toISOString(),
  };

  assert.equal(
    readValidHarnessCheckpoint(checkpoint, chapter.id, fingerprint, stages)?.completedStages.length,
    1,
  );
  assert.equal(
    readValidHarnessCheckpoint(checkpoint, chapter.id, `${fingerprint}-changed`, stages),
    undefined,
  );
});

test("chapter author harness rejects checkpoints whose completed stage is not valid", () => {
  const { course, chapter } = fixture();
  const stages = buildChapterHarnessStages(course, chapter, 0);
  const fingerprint = buildHarnessContractFingerprint("contract", chapter.id, stages);
  const checkpoint: ChapterHarnessCheckpoint = {
    version: 1,
    chapterId: chapter.id,
    contractFingerprint: fingerprint,
    stageIds: stages.map((stage) => stage.id),
    completedStages: [{
      id: stages[0]!.id,
      content: "I don't have the previous answer content, so I can't continue it.",
    }],
    updatedAt: new Date(0).toISOString(),
  };

  assert.equal(
    readValidHarnessCheckpoint(checkpoint, chapter.id, fingerprint, stages),
    undefined,
  );
});
