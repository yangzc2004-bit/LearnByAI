import { z } from "zod";

export const AVATAR_BUCKET = "learnbyai-avatars";
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const AVATAR_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

export type AvatarMimeType = (typeof AVATAR_ALLOWED_MIME_TYPES)[number];

const AVATAR_MIME_TO_EXTENSION: Record<AvatarMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const AVATAR_EXTENSION_TO_MIME: Record<string, AvatarMimeType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

export const profileUpdateSchema = z
  .object({
    displayName: z.string().trim().max(30).optional(),
    bio: z.string().trim().max(160).optional(),
  })
  .strict();

export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export type ProfileUpdateParseResult =
  | { ok: true; value: { displayName: string | null; bio: string | null } }
  | { ok: false; message: string };

/**
 * Server-side validation for profile updates. Both fields are optional but at
 * least one must be present. An empty string clears the field (stored as null).
 */
export function parseProfileUpdate(body: unknown): ProfileUpdateParseResult {
  const parsed = profileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: "昵称最多 30 个字符，简介最多 160 个字符。" };
  }

  const { displayName, bio } = parsed.data;
  if (displayName === undefined && bio === undefined) {
    return { ok: false, message: "没有需要更新的字段。" };
  }

  return {
    ok: true,
    value: {
      displayName: displayName === undefined ? null : displayName.trim() || null,
      bio: bio === undefined ? null : bio.trim() || null,
    },
  };
}

export function isAllowedAvatarMimeType(value: string | undefined | null): value is AvatarMimeType {
  return Boolean(value && (AVATAR_ALLOWED_MIME_TYPES as readonly string[]).includes(value.toLowerCase()));
}

/**
 * Browser `File.type` is sometimes empty. Fall back to the filename extension
 * before rejecting the upload; the server still verifies magic bytes afterwards.
 */
export function inferAvatarMimeType(fileName: string, declaredType: string): AvatarMimeType | undefined {
  const normalized = declaredType.toLowerCase();
  if (isAllowedAvatarMimeType(normalized)) return normalized;

  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension) return AVATAR_EXTENSION_TO_MIME[extension];
  return undefined;
}

export function avatarExtensionForMime(mime: AvatarMimeType) {
  return AVATAR_MIME_TO_EXTENSION[mime];
}

/**
 * Lightweight content sniffing: SVG is deliberately excluded (scripting risk)
 * and a file that claims to be an image must carry that format's magic bytes.
 */
export function looksLikeAllowedImage(bytes: Uint8Array, mime: AvatarMimeType) {
  if (!bytes || bytes.length < 12) return false;

  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("latin1");

  switch (mime) {
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return ascii(0, 4) === "\x89PNG";
    case "image/gif":
      return ascii(0, 4) === "GIF8";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "image/avif":
      return ascii(4, 8) === "ftyp" && ascii(8, 32).includes("avif");
    default:
      return false;
  }
}

/**
 * Extract the storage path from a public Supabase object URL. Returns
 * undefined when the URL does not point into the avatar bucket.
 */
export function avatarStoragePathFromUrl(
  url: string | null | undefined,
  bucket: string = AVATAR_BUCKET,
) {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    const marker = `/object/public/${bucket}/`;
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return undefined;

    const path = decodeURIComponent(parsed.pathname.slice(index + marker.length));
    return path || undefined;
  } catch {
    return undefined;
  }
}
