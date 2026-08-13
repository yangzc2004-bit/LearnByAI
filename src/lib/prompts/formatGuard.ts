import { canRenderMath } from "@/lib/katexValidate";
import { normalizeMath } from "@/lib/markdownMath";
import { sanitizeMathDelimiters } from "@/lib/sanitizeMath";

export function preRepairMarkdown(content: string) {
  const repairedImageSyntax = normalizeEscapedMarkdownImageSyntax(content);
  const normalized = normalizeLooseOrderedLists(
    replaceLegacyImageLinksWithFigurePlaceholders(
      escapePipesInTableMath(
        wrapResidualBareInlineLatexFragments(
          wrapBareMathParagraphs(
            repairMarkdownFences(
              wrapBareInlineLatexFragments(
                removeOrphanDisplayMathDelimiters(
                  normalizeMath(
                    removeOrphanDisplayMathDelimiters(
                      normalizeTextbookCallouts(
                        normalizeInlineFenceBoundaries(repairedImageSyntax),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return normalized
    .replace(/(^|\n)\$\s*\n([\s\S]*?)\n\$\s*(?=\n|$)/gu, (_match, prefix = "", body = "") => {
      return `${prefix}$$\n${body.trim()}\n$$`;
    })
    .replace(/[ \t]+\n/g, "\n")
    // Collapse blank-line runs left behind by removed empty fences so the
    // result is stable under a second pass (the renderer runs this again).
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Some historical writer outputs put an empty pair of `$$` directly before or
 * after every real display block:
 *
 *   $$
 *   $$
 *   \frac{...}{...}
 *   $$
 *   $$
 *
 * Markdown then treats the later pairs as independent empty blocks, and any
 * stateful math repair can mistake following prose for formula content. Remove
 * only consecutive duplicate delimiters; a deliberately adjacent pair of
 * display formulas still keeps one closing and one opening delimiter.
 */
function removeOrphanDisplayMathDelimiters(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inDisplayMath = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "$$") {
      output.push(line);
      continue;
    }

    if (!inDisplayMath && isClearlyOrphanClosingDisplayDelimiter(lines, index)) {
      continue;
    }

    if (inDisplayMath) {
      output.push("$$");
      inDisplayMath = false;
      continue;
    }

    const next = nextNonEmptyLine(lines, index + 1);
    if (next && looksLikeDisplayMathStart(next)) {
      output.push("$$");
      inDisplayMath = true;
    }
    // Otherwise it is an unmatched closing delimiter. Dropping it keeps
    // subsequent prose out of a false display-math zone.
  }

  return output.join("\n");
}

function nextNonEmptyLine(lines: string[], start: number) {
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed) return trimmed;
  }
  return "";
}

function previousNonDelimiterLine(lines: string[], start: number) {
  for (let index = start; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed && trimmed !== "$$") return trimmed;
  }
  return "";
}

function isClearlyOrphanClosingDisplayDelimiter(lines: string[], index: number) {
  const previous = previousNonDelimiterLine(lines, index - 1);
  const next = nextNonEmptyLine(lines, index + 1);
  return Boolean(previous && next && looksLikeDisplayMathStart(previous) && !looksLikeDisplayMathStart(next));
}

function looksLikeDisplayMathStart(value: string) {
  if (value === "$$") return false;
  if (/^\\(?:begin|frac|dfrac|tfrac|sum|prod|int|sqrt|left|right|mathbf|mathbb|mathcal|operatorname|det|log|ln|partial|nabla)\b/u.test(value)) {
    return true;
  }
  return /[=<>≈≤≥]|\\[A-Za-z]+|[_^{}]/u.test(value) && !/[一-鿿]/u.test(value);
}

/**
 * Some OpenAI-compatible providers return a complete fenced block on the same
 * physical line as surrounding prose. CommonMark only recognizes a fence at a
 * block boundary, so turn those delimiters into real lines before the normal
 * fence and math repair passes run.
 */
function normalizeInlineFenceBoundaries(content: string) {
  const output: string[] = [];
  let cursor = 0;
  let inFence = false;

  while (cursor < content.length) {
    const marker = content.indexOf("```", cursor);
    if (marker < 0) {
      output.push(content.slice(cursor));
      break;
    }

    output.push(content.slice(cursor, marker));
    if (!inFence) {
      const suffix = content.slice(marker + 3);
      const language = suffix.match(/^([A-Za-z0-9_+-]{1,24})(?=\s)/u)?.[1] ?? "";
      trimTrailingHorizontalWhitespace(output);
      ensureTrailingNewline(output, 2);
      output.push(`\`\`\`${language}\n`);
      cursor = marker + 3 + language.length;
      while (content[cursor] === " " || content[cursor] === "\t") cursor += 1;
      inFence = true;
      continue;
    }

    trimTrailingHorizontalWhitespace(output);
    ensureTrailingNewline(output, 1);
    output.push("```\n\n");
    cursor = marker + 3;
    while (content[cursor] === " " || content[cursor] === "\t") cursor += 1;
    inFence = false;
  }

  return output.join("").replace(/\n{4,}/gu, "\n\n\n");
}

function trimTrailingHorizontalWhitespace(chunks: string[]) {
  const last = chunks.length - 1;
  if (last < 0) return;
  chunks[last] = chunks[last]!.replace(/[ \t]+$/u, "");
}

function ensureTrailingNewline(chunks: string[], count: number) {
  const joinedTail = chunks.at(-1) ?? "";
  const existing = joinedTail.match(/\n*$/u)?.[0].length ?? 0;
  if (existing < count) chunks.push("\n".repeat(count - existing));
}

/**
 * A model occasionally escapes the brackets in an image token, for example
 * `!\[图示\](images/example.png)`. The math normalizer correctly treats `\[`
 * as a display-math delimiter, so this must run before any LaTeX processing.
 */
function normalizeEscapedMarkdownImageSyntax(content: string) {
  return transformOutsideFences(content, (text) =>
    text
      .replace(/!\\\[([^\]\r\n]*)\\\]\\\(([^)\r\n]+)\\\)/gu, "![$1]($2)")
      .replace(/!\\\[([^\]\r\n]*)\\\]\(([^)\r\n]+)\)/gu, "![$1]($2)")
      .replace(/!\[([^\]\r\n]*)\]\\\(([^)\r\n]+)\\\)/gu, "![$1]($2)"),
  );
}

/**
 * Imported reference documents may contain local image paths such as
 * `images/dp-backup.png`. They cannot be resolved by the web reader or copied
 * into TeX, so convert them to the standard figure protocol. Fresh chapters
 * render the placeholder in the normal figure pipeline; older chapters can be
 * healed with the same pipeline instead of leaking a literal Markdown token.
 */
function replaceLegacyImageLinksWithFigurePlaceholders(content: string) {
  return transformOutsideFences(content, (text) =>
    text.replace(/!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/gu, (whole, alt: string, url: string) => {
      const source = url.trim();
      if (source.startsWith("/api/illustrations/")) return whole;

      const caption = normalizeLegacyFigureCaption(alt);
      if (!caption) return "";
      return [
        ":::learnbyai-figure",
        `caption: ${caption}`,
        `prompt: 为教材绘制“${caption}”的简洁示意图，突出正文所述的关键对象、关系或流程。`,
        `diagramSpec: ${caption}`,
        "textLabelsAllowed: true",
        ":::",
      ].join("\n");
    }),
  );
}

function normalizeLegacyFigureCaption(alt: string) {
  return alt
    .replace(/^\s*图\s*\d+(?:[.\-]\d+)?\s*[：:、.]?\s*/u, "")
    .replace(/[*_`[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

/**
 * A long-form writer can leave a valid LaTeX expression naked inside an
 * otherwise ordinary Chinese sentence:
 *
 *   逐元素解读：\alpha_{11} = -0.1 表示自限制；
 *
 * It is not a display formula and therefore cannot be fixed by the paragraph
 * wrapper below. Extract only the command-led mathematical fragment, ask KaTeX
 * whether it is valid, then give it explicit inline delimiters. The scanner
 * deliberately stops at normal CJK prose, so it cannot accidentally wrap the
 * rest of an explanation as math.
 */
function wrapBareInlineLatexFragments(content: string) {
  return transformOutsideFences(content, (text) => {
    const lines = text.split("\n");
    let inDisplayMath = false;

    return lines
      .map((line) => {
        if (line.trim() === "$$") {
          inDisplayMath = !inDisplayMath;
          return line;
        }
        return inDisplayMath ? line : wrapBareInlineLatexInLine(line);
      })
      .join("\n");
  });
}

function wrapBareInlineLatexInLine(line: string) {
  let output = "";
  let index = 0;

  while (index < line.length) {
    const char = line[index]!;

    // Preserve existing inline math verbatim. sanitizeMathDelimiters owns
    // malformed dollar recovery later in the pipeline.
    if (char === "$" && line[index - 1] !== "\\") {
      const closing = findInlineMathClosingDollar(line, index + 1);
      if (closing >= 0) {
        output += line.slice(index, closing + 1);
        index = closing + 1;
        continue;
      }
    }

    if (
      char !== "\\" ||
      line[index - 1] === "\\" ||
      hasUnwrappedLatexPrefix(output) ||
      !hasBareInlineLatexStartBoundary(line, index) ||
      !isStrongLatexCommandAt(line, index)
    ) {
      output += char;
      index += 1;
      continue;
    }

    const candidate = findRenderableBareInlineLatex(line, index, findBareInlineLatexEnd(line, index));
    if (candidate) {
      output += `$${candidate.value}$`;
      index = candidate.end;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function wrapResidualBareInlineLatexFragments(content: string) {
  return transformOutsideFences(content, (text) => {
    const lines = text.split("\n");
    let inDisplayMath = false;

    return lines
      .map((line) => {
        if (line.trim() === "$$") {
          inDisplayMath = !inDisplayMath;
          return line;
        }
        return inDisplayMath ? line : wrapResidualBareInlineLatex(line);
      })
      .join("\n");
  });
}

function wrapResidualBareInlineLatex(line: string) {
  // sanitizeMathDelimiters has dedicated recovery for one-sided escaped dollar
  // delimiters. Do not let this late pass split that incomplete math first.
  if (line.includes("\\$")) return line;

  let output = "";
  let index = 0;

  while (index < line.length) {
    const char = line[index]!;
    if (char === "$" && line[index - 1] !== "\\") {
      const closing = findInlineMathClosingDollar(line, index + 1);
      if (closing >= 0) {
        output += line.slice(index, closing + 1);
        index = closing + 1;
        continue;
      }
    }

    if (
      char !== "\\" ||
      line[index - 1] === "\\" ||
      !hasResidualBareInlineLatexStartBoundary(line, index) ||
      !isStrongLatexCommandAt(line, index)
    ) {
      output += char;
      index += 1;
      continue;
    }

    const start = findResidualMathPrefixStart(line, index);
    const candidate = findRenderableBareInlineLatex(line, start, findBareInlineLatexEnd(line, index));
    if (candidate) {
      output = output.slice(0, Math.max(0, output.length - (index - start)));
      output += `$${candidate.value}$`;
      index = candidate.end;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function hasUnwrappedLatexPrefix(value: string) {
  const outsideMath = value.replace(/(?<!\\)\$[^\n$]*?(?<!\\)\$/gu, "");
  return /\\[A-Za-z]+/u.test(outsideMath);
}

function findInlineMathClosingDollar(value: string, start: number) {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "$" && value[index - 1] !== "\\") return index;
  }
  return -1;
}

function hasBareInlineLatexStartBoundary(value: string, index: number) {
  const previous = value[index - 1];
  return (
    previous === undefined ||
    /[\s“"'：:；;，,。！？!?、]/u.test(previous) ||
    /[一-鿿]/u.test(previous)
  );
}

function hasResidualBareInlineLatexStartBoundary(value: string, index: number) {
  const previous = value[index - 1];
  return (
    previous === undefined ||
    /[\s\p{P}\p{S}]/u.test(previous) ||
    /[\u4e00-\u9fff]/u.test(previous) ||
    isShortMathPrefixBeforeCommand(value, index)
  );
}

function isShortMathPrefixBeforeCommand(value: string, index: number) {
  let start = index;
  while (start > 0 && /[A-Za-z0-9_./^+\-]/u.test(value[start - 1]!)) start -= 1;
  const prefix = value.slice(start, index);
  return (
    /^[A-Z]$/u.test(prefix) ||
    /^[a-z](?:[a-z]?\/[a-z]?)?$/u.test(prefix) ||
    /^-?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(prefix)
  );
}

function isStrongLatexCommandAt(value: string, index: number) {
  const command = value.slice(index).match(
    /^\\(?:alpha|beta|gamma|theta|lambda|sigma|mu|pi|rho|tau|phi|psi|omega|delta|epsilon|varepsilon|eta|kappa|xi|zeta|Alpha|Beta|Gamma|Theta|Lambda|Sigma|Phi|Psi|Omega|Delta|Pi|Tau|Xi|Eta|Rho|Mu|Nu|Kappa|Zeta|frac|dfrac|tfrac|sqrt|sum|prod|int|partial|nabla|mathbf|mathbb|mathcal|mathrm|operatorname|text|hat|bar|vec|dot|ddot|left|right|begin|end|quad|qquad|cdot|times|le|leq|ge|geq|ne|neq|approx|sim|pm|mp|infty|ldots|dots|det|log|ln|exp|in|to|mapsto|forall|exists|cdots|ldotp|Pr)(?![A-Za-z])/u,
  );
  return Boolean(command);
}

function isLikelyBareInlineLatex(value: string) {
  return /\\[A-Za-z]+/u.test(value) && !/[\n$]/u.test(value) && value.length <= 220;
}

function findBareInlineLatexEnd(value: string, start: number) {
  let index = start;
  let braceDepth = 0;

  while (index < value.length && index - start < 220) {
    const char = value[index]!;

    if (char === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      index += 1;
      continue;
    }
    if (
      /[A-Za-z0-9_\\^=<>+\-*/|()[\],.;:!?'"\s]/u.test(char) ||
      (braceDepth > 0 && /[一-鿿]/u.test(char))
    ) {
      index += 1;
      continue;
    }
    break;
  }

  return index;
}

function findResidualMathPrefixStart(value: string, commandStart: number) {
  let start = commandStart;
  while (start > 0 && /[A-Za-z0-9_\\^=<>+\-*/|()[\],.;:!?'"]/u.test(value[start - 1]!)) {
    start -= 1;
  }
  return start;
}

function findRenderableBareInlineLatex(value: string, start: number, maxEnd: number) {
  const full = value.slice(start, maxEnd).trimEnd();
  if (isLikelyBareInlineLatex(full) && canRenderMath(full, false)) {
    return { value: full, end: start + full.length };
  }

  // A prose parenthesis or punctuation mark can be swallowed by the optimistic
  // scan above. Search backwards for the longest complete piece KaTeX accepts,
  // rather than giving up and leaking a literal command into the reader.
  for (let end = start + full.length - 1; end > start; end -= 1) {
    const candidate = value.slice(start, end).trimEnd();
    if (
      !candidate ||
      !/[A-Za-z0-9})\]]$/u.test(candidate) ||
      !isLikelyBareInlineLatex(candidate) ||
      !canRenderMath(candidate, false)
    ) {
      continue;
    }
    return { value: candidate, end: start + candidate.length };
  }

  return undefined;
}

/**
 * Writers often emit a loose Markdown list as a series of `1.` blocks
 * separated by blank explanatory paragraphs. CommonMark treats those as many
 * independent one-item lists, so both the reader and TeX export show repeated
 * “1.”. Canonicalize them to one ordered list with indented continuations.
 */
function normalizeLooseOrderedLists(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;
  let fenceMarker = "";
  let inDisplayMath = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      if (!fenceMarker) fenceMarker = fence[1]![0]!;
      else if (fence[1]![0] === fenceMarker) fenceMarker = "";
      output.push(line);
      index += 1;
      continue;
    }
    if (fenceMarker) {
      output.push(line);
      index += 1;
      continue;
    }
    if (line.trim() === "$$") {
      inDisplayMath = !inDisplayMath;
      output.push(line);
      index += 1;
      continue;
    }
    if (inDisplayMath || !/^\s*\d+[.)]\s+/u.test(line)) {
      output.push(line);
      index += 1;
      continue;
    }

    const parsed = collectLooseOrderedList(lines, index);
    if (!parsed) {
      output.push(line);
      index += 1;
      continue;
    }

    parsed.items.forEach((item, itemIndex) => {
      const clean = trimBlankEdges(item);
      const first = clean.shift() ?? "";
      output.push(`${itemIndex + 1}. ${first}`);
      for (const continuation of clean) {
        output.push(continuation ? `   ${removeOneListIndent(continuation)}` : "");
      }
      if (itemIndex < parsed.items.length - 1 && clean.length > 0) output.push("");
    });
    index = parsed.nextIndex;
  }

  return output.join("\n");
}

function collectLooseOrderedList(lines: string[], startIndex: number) {
  const items: string[][] = [];
  let current: string[] | undefined;
  let index = startIndex;
  let nonListLines = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/u.test(line) || /^\s*:::\s*learnbyai-figure/u.test(line)) break;
    const marker = line.match(/^\s*\d+[.)]\s+([\s\S]*)$/u);
    if (marker) {
      if (current) items.push(current);
      current = [marker[1] ?? ""];
      nonListLines = 0;
      index += 1;
      continue;
    }
    if (!current) break;
    current.push(line);
    if (line.trim()) nonListLines += 1;
    // A normal paragraph after a one-item list should not absorb a whole
    // chapter while we look for another marker.
    if (items.length === 0 && nonListLines > 24) break;
    index += 1;
  }
  if (current) items.push(current);
  return items.length >= 2 ? { items, nextIndex: index } : undefined;
}

function trimBlankEdges(lines: string[]) {
  const output = [...lines];
  while (output[0]?.trim() === "") output.shift();
  while (output.at(-1)?.trim() === "") output.pop();
  return output;
}

function removeOneListIndent(value: string) {
  return value.replace(/^(?: {3}|\t)/u, "");
}

function transformOutsideFences(content: string, transform: (text: string) => string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  const normal: string[] = [];
  let fenceMarker = "";

  const flushNormal = () => {
    if (normal.length) output.push(transform(normal.join("\n")));
    normal.length = 0;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (!fenceMarker && fence) {
      flushNormal();
      fenceMarker = fence[1]![0]!;
      output.push(line);
      continue;
    }
    if (fenceMarker) {
      output.push(line);
      if (fence?.[1]?.[0] === fenceMarker) fenceMarker = "";
      continue;
    }
    normal.push(line);
  }
  flushNormal();
  return output.join("\n");
}

/**
 * In a Markdown table, `|` is the column separator — but a `|` inside inline math
 * ($...$) is a LaTeX operator (conditional probability `\pi(a|s)`, `p(s',r|s,a)`).
 * Markdown splits the formula across cells and breaks the `$...$`, so the math
 * renders as raw source and spills into the next column. Rewrite those pipes to
 * `\mid ` (renders as the same vertical bar, but contains no literal `|` to break
 * the row). Only touches `|` inside `$...$` on table rows — never absolute-value
 * bars in display math or ordinary prose.
 */
function escapePipesInTableMath(content: string) {
  return content
    .split("\n")
    .map((line) => {
      if (!/^\s*\|.*\|/u.test(line)) return line; // not a table row
      return line.replace(/\$(?!\$)([^$\n]+?)\$/gu, (whole, inner: string) =>
        inner.includes("|") ? `$${inner.replace(/(?<!\\)\|/gu, "\\mid ")}$` : whole,
      );
    })
    .join("\n");
}

export function postRepairMarkdown(content: string) {
  return sanitizeMathDelimiters(preRepairMarkdown(stripOuterFence(content)));
}

/**
 * Heal whole paragraphs of naked LaTeX that the line-level heuristics in
 * markdownMath can't see. Long model outputs sometimes emit an entire display
 * formula with NO delimiters at all, split across lines, e.g.
 *
 *   (P r)(\text{晴})
 *   =
 *   0.8\times 1+0.2\times (-1)
 *   =0.6.
 *
 * The first line starts with "(" — no strong-command prefix — so per-line
 * wrapping misses it and the whole block renders as broken plain text (the
 * dominant "formula looks broken" failure in real long chapters). Instead of
 * growing regex lists forever, this pass works at paragraph granularity with
 * KaTeX itself as the judge: a paragraph outside any fence/$$ that contains a
 * LaTeX command, has no prose (no CJK outside \text{}, no English sentences),
 * no $ delimiters — and that KaTeX can render as a whole — is a bare display
 * formula and gets wrapped in $$.
 */
function wrapBareMathParagraphs(content: string) {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inMath = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      out.push(line);
      index += 1;
      continue;
    }
    if (inFence || inMath || !trimmed) {
      if (trimmed === "$$") inMath = !inMath;
      out.push(line);
      index += 1;
      continue;
    }
    if (trimmed === "$$") {
      inMath = true;
      out.push(line);
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = (lines[index] ?? "").trim();
      if (!current || current === "$$" || /^(```|~~~)/u.test(current)) break;
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    out.push(...(tryWrapBareMathParagraph(paragraph) ?? paragraph));
  }

  return out.join("\n");
}

function tryWrapBareMathParagraph(paragraph: string[]): string[] | undefined {
  const trimmedLines = paragraph.map((line) => line.trim());
  // Never touch structured Markdown (headings, lists, quotes, tables, figure
  // blocks). A leading "|" only means "table row" when the line also ends with
  // one — |G_t| \leq ... is an absolute value, not a table.
  if (trimmedLines.some((line) => /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|:::)/u.test(line) || (line.startsWith("|") && line.endsWith("|")))) {
    return undefined;
  }
  const joined = trimmedLines.join("\n");
  if (joined.length < 4) return undefined;
  if (/(?<!\\)\$/u.test(joined)) return undefined; // already delimited somewhere
  if (joined.includes("![") || joined.includes("](") || joined.includes("<!--")) return undefined;
  if (!/\\[A-Za-z]+/u.test(joined)) return undefined; // needs a real LaTeX command
  if (hasProseCjkOutsideTextCommands(joined)) return undefined;
  if (hasPlainProseWords(joined)) return undefined;
  if (!canRenderMath(joined, true)) return undefined; // KaTeX has the final say
  return ["$$", ...trimmedLines, "$$"];
}

function hasProseCjkOutsideTextCommands(value: string) {
  const stripped = value.replace(
    /\\(?:text|textbf|textit|textrm|textsf|texttt|mathrm|mathbf|mathsf|mathtt|operatorname)\s*\{[^{}]*\}/gu,
    "",
  );
  return /[一-鿿]/u.test(stripped);
}

function hasPlainProseWords(value: string) {
  const stripped = value
    .replace(/\\(?:text|textbf|textit|textrm|textsf|texttt|mathrm|mathbf|operatorname)\s*\{[^{}]*\}/gu, "")
    .replace(/\\[A-Za-z]+/gu, "");
  return (stripped.match(/[A-Za-z]{3,}/gu) ?? []).length >= 3;
}

export function buildFormatGuardPrompt(content: string) {
  const repaired = preRepairMarkdown(content);

  return `# Task: Markdown and LaTeX Format Guard

你是一名中文教材排版质检员。你的唯一任务是修复下面教材正文中的 Markdown、LaTeX、代码块和标题格式问题。

硬性要求：
- 只修格式，不扩写、不删减知识点、不改变论证顺序。
- 不输出解释，不输出 JSON，不输出审查报告，只输出修复后的完整 Markdown 正文。
- 保留中文正文含义。
- 保留原有章节标题和小节标题，但可以修正明显错误的 Markdown 标题层级。
- 行内公式必须是 $...$。
- 块级公式必须是：

$$
公式
$$

- 禁止出现单行 "$ Y = ..."、"$Y = ..."、孤立 "$"、\\[...\\]、\\(...\\)。
- 多行推导、cases、aligned、矩阵必须放在块级公式中。
- 条件独立必须写成 \\perp\\!\\!\\!\\perp，禁止 \\perp!!!\\perp。
- 代码必须放在 fenced code block 中，并尽量保留语言名。
- 删除空代码块和多余的连续 fence，例如正文末尾的单独 \`\`\` 或 \`\`\`\n\`\`\`。
- 不要把中文正文放进 $$...$$。
- 若发现 $$ 或 $ 包裹的是中文正文 / 习题标题 / 说明文字，删除这对美元符号，把它还原成普通文本。
- \\text、\\mathrm、\\operatorname 等文本命令的花括号内如含下划线，必须转义为 \\_（如 \\text{\\_\\_end\\_\\_}），禁止出现裸下划线。
- 不要生成“以下是修复后的内容”之类的前后缀。

待修复正文：

${repaired}`;
}

function stripOuterFence(content: string) {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1] ?? trimmed;
}

function repairMarkdownFences(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const repaired: string[] = [];
  let inFence = false;
  let fenceStart = -1;

  for (const line of lines) {
    const isFence = /^\s*(`{3,}|~{3,})/.test(line);
    if (!isFence) {
      repaired.push(line);
      continue;
    }

    if (!inFence) {
      inFence = true;
      fenceStart = repaired.length;
      repaired.push(line);
      continue;
    }

    const body = repaired.slice(fenceStart + 1).join("\n").trim();
    if (!body) {
      repaired.splice(fenceStart, repaired.length - fenceStart);
    } else if (isAccidentallyFencedMathProse(repaired[fenceStart] ?? "", body)) {
      repaired.splice(fenceStart, repaired.length - fenceStart, ...body.split("\n"));
    } else {
      repaired.push(line);
    }
    inFence = false;
    fenceStart = -1;
  }

  if (inFence) {
    const body = repaired.slice(fenceStart + 1).join("\n").trim();
    if (body) repaired.push("```");
    else repaired.splice(fenceStart, repaired.length - fenceStart);
  }

  return repaired.join("\n").replace(/\n```[ \t]*\n```[ \t]*$/u, "").trim();
}

/**
 * Examples and definitions are textbook elements, not quotations. Older
 * writers emitted them as `>` blocks, which made the reader apply the visual
 * language of a social-media callout: border, tinted background and italics.
 * Canonicalize the legacy form to a bold textbook lead-in followed by ordinary
 * prose so web, PDF and TeX all share the same semantics.
 */
function normalizeTextbookCallouts(content: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!/^\s*>\s?/u.test(lines[index] ?? "")) {
      output.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    const quoted: string[] = [];
    const original: string[] = [];
    while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? "")) {
      original.push(lines[index] ?? "");
      quoted.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
      index += 1;
    }

    const first = quoted.findIndex((line) => line.trim().length > 0);
    const title = first >= 0 ? textbookCalloutTitle(quoted[first] ?? "") : undefined;
    if (!title || first < 0) {
      output.push(...original);
      continue;
    }

    output.push(`**${title}**`);
    const body = quoted.slice(first + 1);
    while (body[0]?.trim() === "") body.shift();
    while (body.at(-1)?.trim() === "") body.pop();
    if (body.length > 0) {
      const normalizedBody: string[] = [];
      for (const line of body) {
        const nestedTitle = textbookCalloutTitle(line);
        if (nestedTitle) {
          while (normalizedBody.at(-1)?.trim() === "") normalizedBody.pop();
          normalizedBody.push("", `**${nestedTitle}**`, "");
        } else {
          normalizedBody.push(line);
        }
      }
      while (normalizedBody.at(-1)?.trim() === "") normalizedBody.pop();
      output.push("", ...normalizedBody, "");
    }
  }

  return output.join("\n");
}

function textbookCalloutTitle(value: string) {
  const title = value
    .trim()
    .replace(/^(?:\*\*|__)([\s\S]*?)(?:\*\*|__)$/u, "$1")
    .trim();
  return /^(?:例|定义)(?=\s|[0-9一二三四五六七八九十]|[：:])/u.test(title) ? title : undefined;
}

function isAccidentallyFencedMathProse(opener: string, body: string) {
  const language = opener.replace(/^\s*(?:`{3,}|~{3,})/u, "").trim().toLowerCase();
  if (language && !["text", "markdown", "md"].includes(language)) return false;
  if (!/[\u4e00-\u9fff]/u.test(body) || !/\$[^$\n]{1,200}\$/u.test(body)) return false;
  if (/^\s*(?:caption|prompt|diagramSpec|textLabelsAllowed)\s*:/imu.test(body)) return false;
  if (/(?:=>|->|<-|[{};]|\b(?:class|const|def|for|function|if|import|return|while)\b)/iu.test(body)) return false;
  return true;
}
