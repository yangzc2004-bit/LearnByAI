/**
 * Post-authoring, pre-download export QA. Deterministic, no LLM, no
 * server-only deps — the safety net that catches the residue classes a reader
 * complained about: literal `$`/backtick glyphs printed on the page, escaped
 * heading hashes (an unhandled Markdown level), math commands leaking into
 * text mode, and heading levels that would number as "N.M.0.K".
 *
 * Two entry points:
 * - qaGeneratedTex(tex): scans the converted LaTeX source (textbook mode).
 * - qaChapterMarkdownForExport(markdown): scans the markdown right before an
 *   HTML print fallback, so the fallback path gets the same safety net.
 */

export type ExportQaIssue = {
  check: string;
  severity: "error" | "warning";
  message: string;
  context: string;
};

const MATH_COMMAND_LEAK = String.raw`\\(?:frac|dfrac|tfrac|sum|prod|int|partial|nabla|leq|geq|neq|ne|approx|cdot|times|infty|sqrt|mathbb|mathcal|mathbf|operatorname)(?![a-zA-Z])`;
const CONTEXT_MAX = 80;

function contextOf(line: string) {
  const trimmed = line.trim();
  return trimmed.length > CONTEXT_MAX ? `${trimmed.slice(0, CONTEXT_MAX)}…` : trimmed;
}

function issue(
  check: string,
  severity: ExportQaIssue["severity"],
  message: string,
  line: string,
): ExportQaIssue {
  return { check, severity, message, context: contextOf(line) };
}

/**
 * Scan the converted LaTeX source for residue that would reach the printed
 * page. lstlisting bodies and display-math bodies are skipped (code and math
 * are legitimately raw).
 */
export function qaGeneratedTex(tex: string): ExportQaIssue[] {
  const issues: ExportQaIssue[] = [];
  const lines = tex.split(/\r?\n/u);
  let inListing = false;
  let inDisplayMath = false;
  const envBalance = new Map<string, number>();
  let chapterHasSubsection = false;
  let chapterHasSubsubsection = false;

  const flushChapter = () => {
    if (chapterHasSubsubsection && !chapterHasSubsection) {
      issues.push({
        check: "export_qa.orphan_subsubsection",
        severity: "error",
        message: "本章存在 \\subsubsection 但没有任何 \\subsection，编号会打印成 N.M.0.K 畸形层级。",
        context: "\\subsubsection without \\subsection in chapter",
      });
    }
    chapterHasSubsection = false;
    chapterHasSubsubsection = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\s*\\chapter\b/u.test(line)) flushChapter();

    if (inListing) {
      if (/^\s*\\end\s*\{lstlisting\}/u.test(line)) inListing = false;
      continue;
    }
    if (/^\s*\\begin\s*\{lstlisting\}/u.test(line)) {
      inListing = true;
      continue;
    }

    // Track display math; its body is legitimately raw.
    if (inDisplayMath) {
      if (trimmed === "$$") inDisplayMath = false;
      // Still track environment balance inside math so \begin{align} leaks surface.
      for (const match of line.matchAll(/\\(begin|end)\{([a-zA-Z*]+)\}/gu)) {
        const delta = match[1] === "begin" ? 1 : -1;
        const name = match[2] ?? "";
        envBalance.set(name, (envBalance.get(name) ?? 0) + delta);
      }
      continue;
    }
    if (trimmed === "$$") {
      inDisplayMath = true;
      continue;
    }
    // Single-line display math: the whole line is math, skip residue checks.
    if (/^\s*\$\$[^$]+\$\$\s*$/u.test(line)) continue;

    if (trimmed.startsWith("\\subsection{")) chapterHasSubsection = true;
    if (trimmed.startsWith("\\subsubsection{")) chapterHasSubsubsection = true;

    if (/\\\$/u.test(line)) {
      issues.push(
        issue(
          "export_qa.escaped_dollar",
          "warning",
          "文本模式中残留转义美元符 \\$，页面上会印出字面 $。",
          line,
        ),
      );
    }
    if (/`/u.test(line)) {
      issues.push(
        issue(
          "export_qa.backtick",
          "warning",
          "文本中残留反引号，会以字面 ` 印出。",
          line,
        ),
      );
    }
    // escapeTex escapes each hash individually, so an unhandled "#### 标题"
    // line reaches TeX as "\#\#\#\# 标题" (backslash-hash pairs).
    if (/^\s*(?:\\#){2,}/u.test(line)) {
      issues.push(
        issue(
          "export_qa.heading_residue",
          "error",
          "残留被转义的 Markdown 标题井号（未处理的标题层级），会以字面 # 印出。",
          line,
        ),
      );
    }
    if (!line.includes("$") && new RegExp(MATH_COMMAND_LEAK, "u").test(line)) {
      issues.push(
        issue(
          "export_qa.math_in_text",
          "error",
          "数学命令泄漏到文本模式（该行无任何 $），XeLaTeX 会编译失败或印出源码。",
          line,
        ),
      );
    }
    for (const match of line.matchAll(/\\(begin|end)\{([a-zA-Z*]+)\}/gu)) {
      const delta = match[1] === "begin" ? 1 : -1;
      const name = match[2] ?? "";
      envBalance.set(name, (envBalance.get(name) ?? 0) + delta);
    }
  }

  flushChapter();
  if (inDisplayMath) {
    issues.push({
      check: "export_qa.unclosed_math",
      severity: "warning",
      message: "文档末尾仍有未闭合的 $$ 数学块。",
      context: "unclosed $$ at end of TeX",
    });
  }
  for (const [name, balance] of envBalance) {
    if (balance !== 0) {
      issues.push({
        check: "export_qa.unbalanced_env",
        severity: "warning",
        message: `环境 ${name} 的 \\begin/\\end 不平衡（差值 ${balance}）。`,
        context: `\\begin{${name}} balance ${balance}`,
      });
    }
  }
  return issues;
}

/**
 * Safety net for the HTML print fallback (and any non-TeX export): scan raw
 * chapter markdown for the same residue classes a reader would see printed.
 */
export function qaChapterMarkdownForExport(markdown: string): ExportQaIssue[] {
  const issues: ExportQaIssue[] = [];
  const lines = markdown.split(/\r?\n/u);
  let inFence = false;
  let inDisplayMath = false;
  let seenH2 = false;
  let seenH3 = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (trimmed === "$$") {
      inDisplayMath = !inDisplayMath;
      continue;
    }
    if (inDisplayMath) continue;

    if (/^##\s+/u.test(trimmed)) seenH2 = true;
    if (/^###\s+/u.test(trimmed) && !seenH2) {
      issues.push(
        issue(
          "export_qa.heading_level_skip",
          "warning",
          "三级标题出现在任何二级标题之前；PDF 导出会压缩层级，请核对小节结构。",
          line,
        ),
      );
      seenH3 = true;
    }
    if (/^####\s+/u.test(trimmed) && !seenH3 && !seenH2) {
      issues.push(
        issue(
          "export_qa.heading_level_skip",
          "warning",
          "四级标题出现在任何二/三级标题之前；PDF 导出会压缩层级，请核对小节结构。",
          line,
        ),
      );
    }

    if (/\\\$/u.test(line)) {
      issues.push(
        issue("export_qa.escaped_dollar", "warning", "正文残留 \\$ 转义，会以字面 $ 显示。", line),
      );
    }
    if (/`/u.test(line)) {
      issues.push(issue("export_qa.backtick", "warning", "正文残留反引号，会以字面 ` 显示。", line));
    }
    if (!line.includes("$") && new RegExp(MATH_COMMAND_LEAK, "u").test(line)) {
      issues.push(
        issue(
          "export_qa.math_in_text",
          "warning",
          "行内疑似泄漏裸 LaTeX 命令且未包裹在 $ 中，渲染时可能原样显示。",
          line,
        ),
      );
    }
    const dollarCount = (line.match(/(?<!\\)\$/gu) ?? []).length;
    if (dollarCount % 2 === 1) {
      issues.push(
        issue(
          "export_qa.unpaired_dollar",
          "warning",
          "该行 $ 数量为奇数（未配对），多余的 $ 会以字面字符显示。",
          line,
        ),
      );
    }
  }

  if (inFence) {
    issues.push({
      check: "export_qa.unclosed_fence",
      severity: "warning",
      message: "章节末尾存在未闭合的代码围栏。",
      context: "unclosed code fence at end of markdown",
    });
  }
  return issues;
}

export function formatQaWarnings(issues: ExportQaIssue[]) {
  return issues.map(
    (item) => `[${item.severity}] ${item.check}: ${item.message}（${item.context}）`,
  );
}

/**
 * Error-severity findings are print defects (heading hashes printed raw, math
 * leaking into text mode, orphan subsubsection numbering). The exporter must
 * NOT deliver a PDF that contains them — treat them as blocking.
 */
export function hasBlockingExportQaIssues(issues: ExportQaIssue[]) {
  return issues.some((item) => item.severity === "error");
}
