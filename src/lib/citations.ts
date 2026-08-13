import type { Citation, Section } from "./types";

/**
 * Build the §label -> sectionId index shared by prompt generation (chapter map)
 * and answer parsing. Labels are 1-based by `section.order`.
 */
export function buildSectionIndex(sections: Section[]): Map<string, string> {
  const index = new Map<string, string>();
  [...sections]
    .sort((a, b) => a.order - b.order)
    .forEach((section, position) => index.set(`§${position + 1}`, section.id));
  return index;
}

/**
 * Extract grounded `[§n]` citation markers from a tutor answer.
 *
 * Markers stay in `content` (the client renders them as chips in place), so the
 * returned list is authoritative metadata, not a text rewrite. Invalid labels —
 * any `§n` absent from the section index — are dropped: they remain plain text
 * on the client and are never recorded as citations, so a hallucinated marker
 * cannot produce a fake reference.
 */
export function extractCitations(text: string, sectionIndex: Map<string, string>): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();

  const marker = /\[§(\d+)\]/gu;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const label = `§${match[1]}`;
    const sectionId = sectionIndex.get(label);
    if (!sectionId || seen.has(label)) continue;
    seen.add(label);
    citations.push({ sectionId, label });
  }

  return citations;
}

/** Remove grounded `[§n]` markers from tutor answer content. */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\[§\d+\]/gu, "");
}
