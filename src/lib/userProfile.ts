import "server-only";

import { createSupabaseServiceClient } from "./supabase/server";
import type { UserProfile } from "./types";
import {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  AvatarMimeType,
  avatarExtensionForMime,
  avatarStoragePathFromUrl,
  inferAvatarMimeType,
  looksLikeAllowedImage,
  parseProfileUpdate,
} from "./profileValidation";

const PROFILE_SELECT = "id, email, display_name, bio, avatar_url, created_at, updated_at";

type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string | null;
};

export type UserProfileUpdateResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; status: number; message: string };

export type UserAvatarUploadResult = UserProfileUpdateResult;

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const supabase = createSupabaseServiceClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.warn("Failed to load user profile:", error.message);
    return null;
  }

  return data ? profileFromRow(data as ProfileRow) : null;
}

export async function updateUserProfile(userId: string, body: unknown): Promise<UserProfileUpdateResult> {
  const parsed = parseProfileUpdate(body);
  if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };

  const supabase = createSupabaseServiceClient();
  if (!supabase) return { ok: false, status: 503, message: "用户资料服务未配置。" };

  const { displayName, bio } = parsed.value;
  const patch: Record<string, unknown> = {
    id: userId,
    updated_at: new Date().toISOString(),
  };
  if (displayName !== null) patch.display_name = displayName;
  if (bio !== null) patch.bio = bio;

  // Trigger handles fresh sign-ups, but upsert keeps this route self-healing
  // if a profile row is ever missing (e.g. a user created before the trigger).
  const { data, error } = await supabase
    .from("profiles")
    .upsert(patch, { onConflict: "id" })
    .select(PROFILE_SELECT)
    .maybeSingle();

  if (error || !data) {
    console.warn("Failed to update user profile:", error?.message ?? "missing row");
    return { ok: false, status: 500, message: "保存用户资料失败，请稍后重试。" };
  }

  return { ok: true, profile: profileFromRow(data as ProfileRow) };
}

export async function uploadUserAvatar(
  userId: string,
  file: { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<UserAvatarUploadResult> {
  const mime = inferAvatarMimeType(file.name, file.type);
  if (!mime) {
    return { ok: false, status: 415, message: "请上传 JPG、PNG、WebP、GIF 或 AVIF 格式的图片。" };
  }

  if (!file.size || file.size > AVATAR_MAX_BYTES) {
    return { ok: false, status: 413, message: "头像图片不能超过 5MB。" };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (!looksLikeAllowedImage(bytes, mime)) {
    return { ok: false, status: 415, message: "文件内容与图片格式不符，请换一张图片重试。" };
  }

  const supabase = createSupabaseServiceClient();
  if (!supabase) {
    return { ok: false, status: 503, message: "头像存储服务未配置。" };
  }

  const previous = await readProfileRow(userId);
  const previousPath = avatarStoragePathFromUrl(previous?.avatar_url);

  const extension = avatarExtensionForMime(mime as AvatarMimeType);
  const path = `${userId}/avatar-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, bytes, {
      contentType: mime,
      cacheControl: "public, max-age=31536000, immutable",
      upsert: true,
    });

  if (uploadError) {
    console.warn("Failed to upload user avatar:", uploadError.message);
    return { ok: false, status: 500, message: "头像上传失败，请稍后重试。" };
  }

  const { data: publicUrl } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const avatarUrl = publicUrl?.publicUrl;
  if (!avatarUrl) {
    await supabase.storage.from(AVATAR_BUCKET).remove([path]).catch(() => undefined);
    return { ok: false, status: 500, message: "头像地址生成失败，请稍后重试。" };
  }

  const updated = await saveProfileAvatarUrl(userId, avatarUrl);
  if (!updated) {
    await supabase.storage.from(AVATAR_BUCKET).remove([path]).catch(() => undefined);
    return { ok: false, status: 500, message: "保存头像失败，请稍后重试。" };
  }

  // Remove the previous file only after the profile row points at the new one.
  // A unique timestamped path also busts browser/CDN caches on every upload.
  if (previousPath && previousPath !== path) {
    await supabase.storage.from(AVATAR_BUCKET).remove([previousPath]).catch((error) => {
      console.warn("Failed to remove previous avatar object:", error.message);
    });
  }

  return { ok: true, profile: updated };
}

export async function deleteUserAvatar(userId: string): Promise<UserAvatarUploadResult> {
  const supabase = createSupabaseServiceClient();
  if (!supabase) return { ok: false, status: 503, message: "头像存储服务未配置。" };

  const previous = await readProfileRow(userId);
  const previousPath = avatarStoragePathFromUrl(previous?.avatar_url);

  const updated = await saveProfileAvatarUrl(userId, null);
  if (!updated) {
    return { ok: false, status: 500, message: "移除头像失败，请稍后重试。" };
  }

  if (previousPath) {
    await supabase.storage.from(AVATAR_BUCKET).remove([previousPath]).catch((error) => {
      console.warn("Failed to remove avatar object:", error.message);
    });
  }

  return { ok: true, profile: updated };
}

async function readProfileRow(userId: string): Promise<ProfileRow | undefined> {
  const supabase = createSupabaseServiceClient();
  if (!supabase) return undefined;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, avatar_url")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.warn("Failed to read profile before avatar change:", error.message);
    return undefined;
  }

  return (data as ProfileRow | null) ?? undefined;
}

async function saveProfileAvatarUrl(userId: string, avatarUrl: string | null): Promise<UserProfile | undefined> {
  const supabase = createSupabaseServiceClient();
  if (!supabase) return undefined;

  const { data, error } = await supabase
    .from("profiles")
    .upsert(
      { id: userId, avatar_url: avatarUrl, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    )
    .select(PROFILE_SELECT)
    .maybeSingle();

  if (error || !data) {
    console.warn("Failed to save profile avatar url:", error?.message ?? "missing row");
    return undefined;
  }

  return profileFromRow(data as ProfileRow);
}

function profileFromRow(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    email: row.email ?? null,
    displayName: row.display_name ?? null,
    bio: row.bio ?? null,
    avatarUrl: row.avatar_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}
