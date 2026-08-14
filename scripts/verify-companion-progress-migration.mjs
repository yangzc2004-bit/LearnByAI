import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";

/**
 * One-time verification for the chapter_companion_progress migration:
 * every legacy chapter_lecture_progress row must have been carried over
 * (same (user, chapter) pairs; new-table distinct users/courses/chapters
 * must be supersets of the legacy ones). Run:
 *   node scripts/verify-companion-progress-migration.mjs
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.log("Skipping companion-progress migration check: missing Supabase configuration.");
  process.exit(0);
}

const service = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: legacyRows, error: legacyError } = await service
  .from("chapter_lecture_progress")
  .select("id, user_id, course_id, chapter_id");
if (legacyError) {
  console.error("Failed to read legacy chapter_lecture_progress:", legacyError.message);
  process.exit(1);
}
const { data: newRows, error: newError } = await service
  .from("chapter_companion_progress")
  .select("id, user_id, course_id, chapter_id");
if (newError) {
  console.error("Failed to read new chapter_companion_progress:", newError.message);
  process.exit(1);
}

const legacy = legacyRows ?? [];
const current = newRows ?? [];
const currentKeys = new Set(current.map((row) => `${row.user_id}|${row.chapter_id}`));
const missing = legacy.filter((row) => !currentKeys.has(`${row.user_id}|${row.chapter_id}`));
const distinct = (rows) => new Set(rows.map((row) => String(row))).size;

const summary = {
  legacyRows: legacy.length,
  companionRows: current.length,
  missingInCompanion: missing.length,
  legacyUsers: distinct(legacy.map((row) => row.user_id)),
  companionUsers: distinct(current.map((row) => row.user_id)),
  legacyCourses: distinct(legacy.map((row) => row.course_id)),
  companionCourses: distinct(current.map((row) => row.course_id)),
  legacyChapters: distinct(legacy.map((row) => row.chapter_id)),
  companionChapters: distinct(current.map((row) => row.chapter_id)),
};
console.log(JSON.stringify(summary, null, 2));

const consistent =
  missing.length === 0 &&
  summary.companionRows >= summary.legacyRows &&
  summary.companionUsers >= summary.legacyUsers &&
  summary.companionCourses >= summary.legacyCourses &&
  summary.companionChapters >= summary.legacyChapters;

if (!consistent) {
  console.error("chapter_companion_progress is missing legacy rows — apply supabase/schema.sql first (backfill runs idempotently).");
  process.exit(1);
}
console.log("Companion-progress migration verified: every legacy (user, chapter) row exists in the new table.");
