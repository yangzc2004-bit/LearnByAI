import { Chapter, Course, QualityIssue } from "../types";

/**
 * Deterministic discipline content-mix checks. Mirrors the per-discipline
 * rules injected into the writer prompt: an algorithm-engineering chapter
 * whose contract promises implementation must actually ship runnable code —
 * pseudocode and comments don't count.
 */

const EXECUTABLE_CODE_LANGUAGES = new Set([
  "python", "py", "r", "julia", "matlab", "octave", "bash", "sh", "shell",
  "sql", "javascript", "js", "typescript", "ts", "java", "c", "cpp", "c++",
  "rust", "go", "ruby", "php", "scala", "swift", "kotlin",
]);

const PSEUDOCODE_LANGUAGES = new Set(["pseudocode", "伪代码", "算法伪代码"]);

const CODE_PROMISE_RE = /实现|代码|可运行|编程|算法流程|算法伪代码|伪代码/u;

type FenceCounts = { executable: number; pseudocode: number };

/** Count fenced code blocks by language class (executable vs pseudocode). */
export function countFencedCodeBlocks(content: string): FenceCounts {
  let executable = 0;
  let pseudocode = 0;
  let inFence = false;
  let language = "";

  for (const line of content.split(/\r?\n/u)) {
    const fence = line.match(/^\s*(?:```|~~~)\s*([A-Za-z0-9_+#.\u4e00-\u9fff-]*)\s*$/u);
    if (!fence) continue;
    if (!inFence) {
      inFence = true;
      language = (fence[1] ?? "").trim().toLowerCase();
      if (EXECUTABLE_CODE_LANGUAGES.has(language)) executable += 1;
      else if (PSEUDOCODE_LANGUAGES.has(language)) pseudocode += 1;
    } else {
      inFence = false;
    }
  }
  return { executable, pseudocode };
}

export function validateDisciplineMix(
  chapter: Chapter,
  content: string,
  course?: Course,
): QualityIssue[] {
  if (!course || course.discipline !== "algorithm-engineering") return [];

  const contract =
    chapter.contract ??
    course.courseBible.chapterContracts?.find((item) => item.chapterTitle === chapter.title);
  const promises = [
    ...(contract?.requiredTopics ?? []),
    ...(contract?.requiredExamples ?? []),
  ];
  const promisesCode = promises.some((item) => CODE_PROMISE_RE.test(item));
  if (!promisesCode) return [];

  const { executable, pseudocode } = countFencedCodeBlocks(content);
  if (executable > 0) return [];

  return [
    {
      check: "discipline.code_mix",
      severity: "error",
      message: "算法/工程类课程的本章契约承诺代码实现，但没有发现可运行语言的代码块。",
      suggestion:
        pseudocode > 0
          ? "本章只有伪代码级代码块；为每个核心算法补充可执行语言（python/r/julia/matlab 等）的代码示例，配逐行讲解与预期输出。"
          : "为每个核心算法补充可执行语言（python/r/julia/matlab 等）的代码示例，配逐行讲解与预期输出；伪代码不计入。",
      source: "TQH" as const,
    },
  ];
}
