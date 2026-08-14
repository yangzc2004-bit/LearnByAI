/**
 * @deprecated The lecture prompt module was renamed to companionGuide.ts
 * (AI 伴学指南). This file re-exports the canonical implementation for one
 * release cycle; new imports must use ./companionGuide.
 */
export {
  buildCompanionGuidePrompt,
  buildLecturePrompt,
  buildMockCompanionGuide,
  buildMockLecture,
  extractChapterSectionAnchors,
  extractChapterSectionNumbers,
  parseCompanionGuide,
  parseLecture,
} from "./companionGuide";
