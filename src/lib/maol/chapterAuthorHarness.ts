import { createHash } from "node:crypto";
import { expectedChapterHeading } from "../chapterHeadings";
import { appendJobEvent, getGenerationJob, patchGenerationJob } from "../jobs";
import { ModelOverrides } from "../modelOverrides";
import { buildChapterWriterPrompt } from "../prompts/chapterWriter";
import { safeErrorMessage } from "../safeError";
import { Chapter, ChapterHarnessCheckpoint, Course, GenerationJob } from "../types";
import { dispatchAgentText } from "./dispatcher";

type HarnessStage = {
  id: string;
  label: string;
  heading?: string;
  kind: "body" | "closing";
};

export async function runChapterAuthorHarness(
  course: Course,
  chapter: Chapter,
  options: {
    jobId: string;
    maxTokens: number;
    overrides?: ModelOverrides;
    onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
  },
) {
  const chapterIndex = course.chapters.findIndex((item) => item.id === chapter.id);
  const masterContract = buildChapterWriterPrompt(course, chapter, {
    chapterIndex,
    chapters: course.chapters,
  });
  const stages = buildChapterHarnessStages(course, chapter, chapterIndex);
  const contractFingerprint = buildHarnessContractFingerprint(masterContract, chapter.id, stages);
  const checkpoint = readValidHarnessCheckpoint(
    getGenerationJob(options.jobId)?.chapterHarnessCheckpoint,
    chapter.id,
    contractFingerprint,
    stages,
  );
  const completed = checkpoint?.completedStages.map((stage) => stage.content) ?? [];
  const perStageTokens = stageTokenBudget(options.maxTokens, stages.length);

  if (completed.length > 0) {
    await reportHarnessResume(options, completed.length, stages.length);
  }

  for (let index = completed.length; index < stages.length; index += 1) {
    const stage = stages[index]!;
    await reportHarnessStage(options, stage, index, stages.length);
    const prompt = buildHarnessStagePrompt({
      masterContract,
      course,
      chapter,
      chapterIndex,
      stages,
      stage,
      stageIndex: index,
      completedText: completed.join("\n\n"),
    });
    const text = await generateValidatedHarnessStage({
      course,
      chapter,
      stage,
      stageIndex: index,
      prompt,
      maxTokens: stage.kind === "closing" ? Math.min(perStageTokens, 4_096) : perStageTokens,
      options,
    });
    completed.push(text.trim());
    await saveHarnessCheckpoint(options, {
      version: 1,
      chapterId: chapter.id,
      contractFingerprint,
      stageIds: stages.map((item) => item.id),
      completedStages: stages.slice(0, completed.length).map((item, completedIndex) => ({
        id: item.id,
        content: completed[completedIndex]!,
      })),
      updatedAt: new Date().toISOString(),
    });
  }

  const chapterText = completed.join("\n\n").trim();
  validateCompletedHarnessChapter(course, chapter, stages, chapterText);
  return chapterText;
}

async function generateValidatedHarnessStage(input: {
  course: Course;
  chapter: Chapter;
  stage: HarnessStage;
  stageIndex: number;
  prompt: string;
  maxTokens: number;
  options: {
    jobId: string;
    overrides?: ModelOverrides;
    onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
  };
}) {
  let prompt = input.prompt;
  let validationError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await reportHarnessStageRetry(input.options, input.stage, validationError);
      prompt = buildHarnessStageRetryPrompt(input.prompt, input.stage, validationError);
    }

    try {
      const text = await dispatchAgentText({
        agent: "AUTHOR",
        jobId: input.options.jobId,
        prompt,
        temperature: 0.45,
        maxTokens: input.maxTokens,
        continueOnOutputLimit: true,
        maxContinuationSegments: 2,
        continuationUsePreviousResponseId: false,
        continuationPrompt: ({ accumulatedText }) => buildHarnessStageContinuationPrompt(
          prompt,
          accumulatedText,
        ),
        validateContinuation: validateHarnessContinuation,
        overrides: input.options.overrides,
        mock: () => mockHarnessStage(input.course, input.chapter, input.stage, input.stageIndex),
        onJobUpdate: input.options.onJobUpdate,
      });
      const normalized = normalizeHarnessStageOutput(
        text,
        expectedChapterHeading(input.course, input.chapter),
        input.stageIndex,
      );
      validateHarnessStageOutput(input.stage, normalized, input.stageIndex);
      return normalized;
    } catch (error) {
      validationError = error;
    }
  }

  throw validationError instanceof Error
    ? validationError
    : new Error(`AUTHOR harness stage ${input.stage.id} failed validation.`);
}

export function buildChapterHarnessStages(
  course: Course,
  chapter: Chapter,
  chapterIndex = course.chapters.findIndex((item) => item.id === chapter.id),
): HarnessStage[] {
  const outlineSections = course.contentMode === "textbook"
    ? course.textbookMeta?.outline?.chapters?.[chapterIndex]?.sections ?? []
    : [];
  const fixedRole = course.contentMode === "textbook"
    ? course.textbookMeta?.outline?.chapters?.[chapterIndex]?.fixedRole
    : undefined;
  const topics = fixedRole
    ? []
    : outlineSections.length > 0
    ? outlineSections.map((section) => section.title)
    : chapter.contract?.requiredTopics ?? [];
  const chapterNumber = Math.max(1, chapterIndex + 1);
  const bodyStages = topics.length > 0
    ? topics.map((topic, index) => ({
        id: `section-${index + 1}`,
        label: topic,
        heading: `${chapterNumber}.${index + 1} ${stripSectionNumber(topic)}`,
        kind: "body" as const,
      }))
    : [{
        id: "chapter-body",
        label: chapter.purpose ?? chapter.description,
        kind: "body" as const,
      }];

  return [
    ...bodyStages,
    {
      id: "chapter-closing",
      label: "本章小结、练习与拓展阅读",
      kind: "closing" as const,
    },
  ];
}

function buildHarnessStagePrompt(input: {
  masterContract: string;
  course: Course;
  chapter: Chapter;
  chapterIndex: number;
  stages: HarnessStage[];
  stage: HarnessStage;
  stageIndex: number;
  completedText: string;
}) {
  const completedHeadings = input.stages
    .slice(0, input.stageIndex)
    .map((stage) => stage.heading ?? stage.label);
  const pendingHeadings = input.stages
    .slice(input.stageIndex + 1)
    .map((stage) => stage.heading ?? stage.label);
  const firstStage = input.stageIndex === 0;
  const requiredChapterHeading = expectedChapterHeading(input.course, input.chapter);

  return `${input.masterContract}

# LearnByAI Chapter Contract Harness

The whole-chapter instructions above are the immutable master contract. This request is one controlled stage in a multi-output chapter harness. Only the output scope changes; every Course Bible rule, Chapter Contract item, confirmed outline item, terminology choice, notation rule, source constraint, and quality requirement remains binding.
For this request only, the stage output contract below replaces the master's phrases "output the complete chapter" and "write all sections". It does not relax or replace any content, continuity, notation, terminology, evidence, formatting, or quality constraint.

Harness ledger:
- Chapter: ${input.chapterIndex + 1}/${input.course.chapters.length} ${input.chapter.title}
- Stage: ${input.stageIndex + 1}/${input.stages.length} ${input.stage.label}
- Completed stages: ${completedHeadings.join("；") || "none"}
- Pending stages: ${pendingHeadings.join("；") || "none"}

${input.completedText ? `Authoritative validated chapter content completed by this harness:
<completed_chapter>
${input.completedText}
</completed_chapter>` : "No chapter content has been written yet."}

Stage output contract:
${firstStage
    ? `- The first line must be exactly: # ${requiredChapterHeading}
- After a short natural opening bridge, write only the current body stage${input.stage.heading ? ` under heading "## ${input.stage.heading}"` : ""}.`
    : input.stage.kind === "closing"
      ? `- Output only these three closing blocks, in this exact order: "## 本章小结", "## 练习", "## 拓展阅读".
- The summary must synthesize all completed stages and bridge to the next chapter according to the Chapter Contract.
- Give 3 to 5 progressively difficult exercises including one open project, then 2 to 4 reliable extension directions or resources.`
      : `- Output only the current body stage under heading "## ${input.stage.heading}".
- Connect naturally from the completed tail without repeating earlier definitions, formulas, examples, headings, tables, or figures.`}
- Do not write any pending stage or closing block early.
- Do not output a preface, status report, JSON, or a whole-document code fence.
- A complete fenced code block must start and end on separate lines.
- Target 800 to 1,400 Chinese characters of explanatory prose for this stage, excluding formulas, tables, and code. Prefer one compact example over repeated exposition.
- Finish within this stage's scope at a clean Markdown boundary; do not keep expanding merely to make the chapter longer.
- Finish this stage at a clean Markdown boundary.`;
}

function buildHarnessStageContinuationPrompt(stagePrompt: string, accumulatedText: string) {
  return `${stagePrompt}

# Harness stage continuation

The same master contract and stage ledger remain binding. The provider cut off this stage before it reached a clean boundary. Continue only the current stage from the authoritative partial output below. Do not claim that prior context is unavailable, do not restart the stage, and do not write later stages.

<partial_stage>
${accumulatedText}
</partial_stage>`;
}

function buildHarnessStageRetryPrompt(
  stagePrompt: string,
  stage: HarnessStage,
  error: unknown,
) {
  return `${stagePrompt}

# Harness stage validation retry

The previous attempt for stage "${stage.label}" was rejected by the deterministic validator:
${safeErrorMessage(error, "The stage output violated its structural contract.")}

Regenerate only the current stage from scratch. Follow the exact required headings and every stage rule above. Do not mention this retry or the rejected output.`;
}

function validateHarnessContinuation(text: string) {
  if (isMissingContextRefusal(text)) {
    throw new Error("AUTHOR Responses continuation lost the chapter harness context.");
  }
}

export function normalizeHarnessStageOutput(
  text: string,
  chapterHeading: string,
  stageIndex: number,
) {
  if (stageIndex === 0) return text;

  const lines = text.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) return text;

  const expected = `# ${chapterHeading}`.trim();
  if (lines[firstContentIndex]!.trim() !== expected) return text;

  lines.splice(firstContentIndex, 1);
  while (lines[firstContentIndex] === "") lines.splice(firstContentIndex, 1);
  return lines.join("\n");
}

function validateHarnessStageOutput(stage: HarnessStage, text: string, stageIndex: number) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`AUTHOR harness stage ${stage.id} returned empty content.`);
  if (isMissingContextRefusal(trimmed)) {
    throw new Error(`AUTHOR harness stage ${stage.id} refused because context was unavailable.`);
  }
  if (stageIndex > 0 && /^#\s+/mu.test(trimmed)) {
    throw new Error(`AUTHOR harness stage ${stage.id} repeated the chapter heading.`);
  }
  if (stage.kind === "body") {
    if (stage.heading && !trimmed.includes(`## ${stage.heading}`)) {
      throw new Error(`AUTHOR harness stage ${stage.id} omitted heading "${stage.heading}".`);
    }
    if (/^##\s+(?:本章小结|练习|拓展阅读)\s*$/mu.test(trimmed)) {
      throw new Error(`AUTHOR harness stage ${stage.id} wrote a closing block too early.`);
    }
  } else {
    for (const heading of ["## 本章小结", "## 练习", "## 拓展阅读"]) {
      if (!trimmed.includes(heading)) {
        throw new Error(`AUTHOR harness closing stage omitted "${heading}".`);
      }
    }
  }
}

function validateCompletedHarnessChapter(
  course: Course,
  chapter: Chapter,
  stages: HarnessStage[],
  content: string,
) {
  const expectedHeading = `# ${expectedChapterHeading(course, chapter)}`;
  if (!content.startsWith(expectedHeading)) {
    throw new Error(`AUTHOR harness output must start with "${expectedHeading}".`);
  }
  for (const stage of stages) {
    if (stage.heading && !content.includes(`## ${stage.heading}`)) {
      throw new Error(`AUTHOR harness output omitted section "${stage.heading}".`);
    }
  }
  if (isMissingContextRefusal(content)) {
    throw new Error("AUTHOR harness output contains a provider context-loss refusal.");
  }
}

function stageTokenBudget(totalTokens: number, stageCount: number) {
  const proportional = Math.ceil(totalTokens / Math.max(1, stageCount) * 0.8);
  return Math.max(2_048, Math.min(3_072, proportional));
}

function stripSectionNumber(value: string) {
  return value.replace(/^\s*\d+(?:\.\d+)+[\s、.．-]*/u, "").trim();
}

export function isMissingContextRefusal(value: string) {
  const sample = value.trim().slice(0, 1_000);
  return [
    /I (?:do not|don't|cannot|can't) (?:have|access|see|retrieve).{0,100}(?:previous|prior|answer|response|context|content)/iu,
    /(?:previous|prior) (?:answer|response|context|content).{0,100}(?:not available|unavailable|missing|not provided)/iu,
    /(?:无法|不能|没法).{0,50}(?:继续|续写).{0,100}(?:上文|前文|之前|先前|内容|回答|上下文)/u,
    /(?:没有|未提供|无法访问|看不到).{0,60}(?:上文|前文|之前的回答|先前的回答|上下文)/u,
  ].some((pattern) => pattern.test(sample));
}

async function reportHarnessStage(
  options: {
    jobId: string;
    onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
  },
  stage: HarnessStage,
  stageIndex: number,
  stageCount: number,
) {
  const job = appendJobEvent(options.jobId, {
    agent: "AUTHOR",
    status: "running",
    message: `Chapter contract harness stage ${stageIndex + 1}/${stageCount}: ${stage.label}`,
  }, { preserveJobStatus: true });
  if (job) await options.onJobUpdate?.(job);
}

async function reportHarnessResume(
  options: {
    jobId: string;
    onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
  },
  completedStageCount: number,
  stageCount: number,
) {
  const job = appendJobEvent(options.jobId, {
    agent: "AUTHOR",
    status: "running",
    message: `Chapter contract harness restored ${completedStageCount}/${stageCount} validated stages; resuming at stage ${completedStageCount + 1}.`,
  }, { preserveJobStatus: true });
  if (job) await options.onJobUpdate?.(job);
}

async function reportHarnessStageRetry(
  options: {
    jobId: string;
    onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
  },
  stage: HarnessStage,
  error: unknown,
) {
  const job = appendJobEvent(options.jobId, {
    agent: "AUTHOR",
    status: "running",
    message: `Chapter contract harness is retrying stage ${stage.id} after validation rejected its structure: ${safeErrorMessage(error, "regenerate with the exact required headings")}.`,
  }, { preserveJobStatus: true });
  if (job) await options.onJobUpdate?.(job);
}

async function saveHarnessCheckpoint(
  options: {
    jobId: string;
    onJobUpdate?: (job: GenerationJob) => Promise<void> | void;
  },
  checkpoint: ChapterHarnessCheckpoint,
) {
  const job = patchGenerationJob(options.jobId, {
    chapterHarnessCheckpoint: checkpoint,
  });
  if (job) await options.onJobUpdate?.(job);
}

export function buildHarnessContractFingerprint(
  masterContract: string,
  chapterId: string,
  stages: HarnessStage[],
) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      chapterId,
      masterContract,
      stages: stages.map(({ id, label, heading, kind }) => ({ id, label, heading, kind })),
    }))
    .digest("hex");
}

export function readValidHarnessCheckpoint(
  checkpoint: ChapterHarnessCheckpoint | undefined,
  chapterId: string,
  contractFingerprint: string,
  stages: HarnessStage[],
) {
  if (!checkpoint || checkpoint.version !== 1) return undefined;
  if (checkpoint.chapterId !== chapterId || checkpoint.contractFingerprint !== contractFingerprint) {
    return undefined;
  }
  const stageIds = stages.map((stage) => stage.id);
  if (
    checkpoint.stageIds.length !== stageIds.length
    || checkpoint.stageIds.some((id, index) => id !== stageIds[index])
    || checkpoint.completedStages.length > stages.length
  ) {
    return undefined;
  }
  for (let index = 0; index < checkpoint.completedStages.length; index += 1) {
    const completed = checkpoint.completedStages[index];
    const stage = stages[index];
    if (!completed || !stage || completed.id !== stage.id) return undefined;
    try {
      validateHarnessStageOutput(stage, completed.content, index);
    } catch {
      return undefined;
    }
  }
  return checkpoint;
}

function mockHarnessStage(
  course: Course,
  chapter: Chapter,
  stage: HarnessStage,
  stageIndex: number,
) {
  if (stageIndex === 0) {
    const heading = `# ${expectedChapterHeading(course, chapter)}`;
    const section = stage.heading ? `\n\n## ${stage.heading}` : "";
    return `${heading}${section}\n\n围绕${stage.label}展开教材说明。`;
  }
  if (stage.kind === "closing") {
    return "## 本章小结\n\n本章完成核心内容梳理。\n\n## 练习\n\n1. 回顾本章核心概念。\n\n## 拓展阅读\n\n1. 阅读相关基础资料。";
  }
  return `## ${stage.heading}\n\n围绕${stage.label}展开说明。`;
}
