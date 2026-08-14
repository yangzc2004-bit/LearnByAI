import { createHash } from "node:crypto";
import type { Chapter } from "./types";

/**
 * Chapter body used for generation and fingerprinting — the persisted shape
 * (content, or the joined section contents for sectioned chapters).
 */
export function getChapterBody(chapter: Chapter) {
  return chapter.content ?? chapter.sections?.map((section) => section.content).join("\n\n") ?? "";
}

/** SHA-256 fingerprint used to anchor decoupled jobs to one chapter version. */
export function hashChapterContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
