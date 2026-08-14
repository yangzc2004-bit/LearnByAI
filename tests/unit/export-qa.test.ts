import assert from "node:assert/strict";
import test from "node:test";
import { qaChapterMarkdownForExport, qaGeneratedTex } from "../../src/lib/quality/exportQa";

test("qaGeneratedTex passes a clean generated chapter", () => {
  const tex = [
    "\\begin{document}",
    "\\chapter{策略迭代}",
    "\\section{价值函数}",
    "正文：价值函数 $v_\\pi(s)$ 的估计。",
    "\\subsection{收敛性}",
    "$$",
    "\\frac{1}{2} + \\sum_{k=1}^n k",
    "$$",
    "\\begin{lstlisting}[style=learnbyai,language=Python]",
    "def pi(): return 3.14  # `backtick` is fine here",
    "\\end{lstlisting}",
    "\\end{document}",
  ].join("\n");
  const issues = qaGeneratedTex(tex);
  assert.deepEqual(issues, []);
});

test("qaGeneratedTex flags escaped dollars, backticks, heading residue, and math-in-text", () => {
  const tex = [
    "\\chapter{强化学习}",
    "\\section{练习}",
    "答案 \\$2.1, 2.1, 1.8, 0.5\\$ 的说明。",
    "文字里有 `反引号` 残留。",
    "\\#\\#\\#\\# 未处理的四级标题",
    "梯度 \\frac{\\partial L}{\\partial w} 没有进入数学模式。",
  ].join("\n");
  const issues = qaGeneratedTex(tex);
  const checks = new Set(issues.map((item) => item.check));
  assert.ok(checks.has("export_qa.escaped_dollar"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.backtick"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.heading_residue"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.math_in_text"), JSON.stringify(issues));
});

test("qaGeneratedTex ignores legitimate math bodies and listings", () => {
  const tex = [
    "\\chapter{矩阵}",
    "\\section{块公式}",
    "$$",
    "\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}",
    "$$",
    "\\begin{lstlisting}[style=learnbyai]",
    "\\frac is not parsed here $ nor `backtick`",
    "\\end{lstlisting}",
  ].join("\n");
  assert.deepEqual(qaGeneratedTex(tex), []);
});

test("qaGeneratedTex flags an orphan \\subsubsection (the 2.4.0.1 defect)", () => {
  const tex = [
    "\\chapter{价值函数}",
    "\\section{状态价值}",
    "\\subsubsection{收敛性}",
    "正文。",
  ].join("\n");
  const issues = qaGeneratedTex(tex);
  assert.ok(issues.some((item) => item.check === "export_qa.orphan_subsubsection"), JSON.stringify(issues));
});

test("qaGeneratedTex flags unbalanced environments and unclosed display math", () => {
  const tex = ["\\chapter{A}", "\\section{B}", "\\begin{itemize}", "\\item x", "$$", "y = 1"].join("\n");
  const issues = qaGeneratedTex(tex);
  const checks = new Set(issues.map((item) => item.check));
  assert.ok(checks.has("export_qa.unbalanced_env"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.unclosed_math"), JSON.stringify(issues));
});

test("qaChapterMarkdownForExport flags \\$ residue, backticks, unpaired $, and heading skips", () => {
  const md = [
    "### 状态价值",
    "练习题 \\$2.1, 2.1, 1.8, 0.5\\$ 与 `代码`。",
    "单美元符 $ 未配对。",
  ].join("\n");
  const issues = qaChapterMarkdownForExport(md);
  const checks = new Set(issues.map((item) => item.check));
  assert.ok(checks.has("export_qa.escaped_dollar"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.backtick"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.unpaired_dollar"), JSON.stringify(issues));
  assert.ok(checks.has("export_qa.heading_level_skip"), JSON.stringify(issues));
});

test("qaChapterMarkdownForExport passes clean markdown", () => {
  const md = [
    "## 2.4 价值函数",
    "正文 $v_\\pi(s)$ 正常。",
    "$$",
    "\\frac{1}{2}",
    "$$",
    "```python",
    "def f(): pass  # `ok`",
    "```",
  ].join("\n");
  assert.deepEqual(qaChapterMarkdownForExport(md), []);
});
