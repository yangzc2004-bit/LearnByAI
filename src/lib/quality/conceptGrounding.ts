import type { QualityIssue } from "../types";

/**
 * Concept grounding triage — deterministic, no LLM. The REVIEWER reports
 * suspect concepts; this module decides what each report entry may do:
 * - a suspect the Course Bible already defines is VERIFIED → no issue at all;
 * - "unsupported" (no source in body or references, per the model) is the
 *   only class allowed to drive the AUTHOR repair loop (warning severity);
 * - "unverified" (the model merely does not recognize the term) stays
 *   info-level: model ignorance must never delete legitimate domain
 *   concepts from the book.
 */

export type SuspectConcept = { term: string; note?: string; status?: "unverified" | "unsupported" };

export function normalizeSuspectConcepts(value: unknown): SuspectConcept[] {
  if (!Array.isArray(value)) return [];
  const suspects: SuspectConcept[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const term = typeof record.term === "string" ? record.term.trim().slice(0, 60) : "";
    const note = typeof record.note === "string" ? record.note.trim().slice(0, 160) : "";
    const status = record.status === "unsupported" ? ("unsupported" as const) : ("unverified" as const);
    if (!term) continue;
    suspects.push({ term, note, status });
  }
  return suspects.slice(0, 10);
}

/** Normalize the reviewer's namedConcepts list for report persistence. */
export function normalizeNamedConcepts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const concepts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const term = entry.trim().slice(0, 60);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    concepts.push(term);
  }
  return concepts.slice(0, 12);
}

export function buildConceptGroundingIssues(
  suspects: SuspectConcept[],
  bibleTerms: string[],
): QualityIssue[] {
  return suspects.flatMap((suspect) => {
    const verifiedByBible = bibleTerms.some((term) => term.includes(suspect.term) || suspect.term.includes(term));
    if (verifiedByBible) return [];
    const unsupported = suspect.status === "unsupported";
    return [{
      check: "reviewer.concept_grounding",
      severity: unsupported ? ("warning" as const) : ("info" as const),
      message: unsupported
        ? `查无出处的概念「${suspect.term}」${suspect.note ? `：${suspect.note}` : "：正文与参考文献均无来源"}。`
        : `模型无法确认概念「${suspect.term}」是否有文献出处${suspect.note ? `（${suspect.note}）` : ""}，请人工核实。`,
      suggestion: unsupported
        ? "确认该术语的文献出处；若为本书自定义概念，请在正文明确标注「本书自定义」，或改用领域标准术语。"
        : "人工确认该术语是否为领域标准术语；若为本书自定义概念，建议在正文标注「本书自定义」。",
      source: "REVIEWER" as const,
    }];
  });
}
