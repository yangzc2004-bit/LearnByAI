"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  Loader2,
  Mail,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/clientApi";
import { publicSafeErrorMessage } from "@/lib/publicSafeError";
import type { UserProfile } from "@/lib/types";
import { UserAvatar } from "./UserAvatar";
import { useUserSession } from "./UserSessionProvider";

const AVATAR_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif";
const AVATAR_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function ProfileSettings() {
  const { user, profile, profileLoading, refreshProfile, setProfile } = useUserSession();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
    setBio(profile?.bio ?? "");
    setSaveError("");
  }, [profile]);

  useEffect(() => {
    return () => clearPreview();
  }, []);

  const email = profile?.email ?? user?.email ?? "—";
  const nameDirty = displayName.trim() !== (profile?.displayName ?? "");
  const bioDirty = bio.trim() !== (profile?.bio ?? "");
  const dirty = nameDirty || bioDirty;

  function clearPreview() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPreviewUrl(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    const normalizedType = file.type.toLowerCase();
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (normalizedType && !AVATAR_ACCEPT.split(",").includes(normalizedType)) {
      setAvatarError("请选择 JPG、PNG、WebP、GIF 或 AVIF 格式的图片。");
      return;
    }
    if (!normalizedType && !AVATAR_EXTENSIONS.includes(extension)) {
      setAvatarError("请选择 JPG、PNG、WebP、GIF 或 AVIF 格式的图片。");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("头像图片不能超过 5MB。");
      return;
    }

    void uploadAvatar(file);
  }

  async function uploadAvatar(file: File) {
    setUploading(true);
    setAvatarError("");
    clearPreview();

    const preview = URL.createObjectURL(file);
    objectUrlRef.current = preview;
    setPreviewUrl(preview);

    try {
      const form = new FormData();
      form.set("file", file);
      const response = await apiFetch("/api/user/profile/avatar", {
        method: "POST",
        body: form,
      });
      const data = (await response.json().catch(() => ({}))) as {
        profile?: UserProfile;
        error?: string;
      };
      if (!response.ok || !data.profile) {
        throw new Error(data.error ?? "头像上传失败。");
      }

      setProfile(data.profile);
      clearPreview();
      toast.success("头像已更新");
    } catch (error) {
      clearPreview();
      setAvatarError(error instanceof Error ? error.message : "头像上传失败。");
    } finally {
      setUploading(false);
    }
  }

  async function removeAvatar() {
    setRemoving(true);
    setAvatarError("");
    setConfirmRemove(false);

    try {
      const response = await apiFetch("/api/user/profile/avatar", { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as {
        profile?: UserProfile;
        error?: string;
      };
      if (!response.ok || !data.profile) {
        throw new Error(data.error ?? "移除头像失败。");
      }

      setProfile(data.profile);
      clearPreview();
      toast.success("头像已移除");
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "移除头像失败。");
    } finally {
      setRemoving(false);
    }
  }

  async function saveProfile() {
    if (!dirty || saving) return;

    setSaving(true);
    setSaveError("");
    try {
      const response = await apiFetch("/api/user/profile", {
        method: "PATCH",
        body: JSON.stringify({
          displayName: displayName.trim(),
          bio: bio.trim(),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        profile?: UserProfile;
        error?: string;
      };
      if (!response.ok || !data.profile) {
        throw new Error(data.error ?? "保存失败。");
      }

      setProfile(data.profile);
      toast.success("个人资料已保存");
    } catch (error) {
      setSaveError(publicSafeErrorMessage(error, "保存失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  }

  if (profileLoading && profile === undefined) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border bg-card py-20">
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">正在读取资料...</span>
      </div>
    );
  }

  if (profile === null) {
    return (
      <div className="rounded-lg border border-border bg-card px-6 py-20 text-center">
        <p className="text-sm text-muted-foreground">用户资料加载失败。</p>
        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => void refreshProfile()}>
          重新加载
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-mono text-base font-semibold text-foreground">个人资料</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            这些信息会展示在你的账户菜单和后续社区功能中。
          </p>
        </div>

        <div className="space-y-8 px-5 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <UserAvatar
              profile={profile}
              email={email}
              avatarUrl={previewUrl}
              className="size-24"
              fallbackClassName="text-3xl"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? <Loader2 size={15} className="animate-spin" /> : <UploadCloud size={15} />}
                {uploading ? "上传中..." : "上传头像"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={removing || uploading || (!profile?.avatarUrl && !previewUrl)}
                onClick={() => setConfirmRemove(true)}
              >
                {removing ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                移除头像
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={AVATAR_ACCEPT}
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          </div>
          {avatarError ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {avatarError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              支持 JPG、PNG、WebP、GIF、AVIF，大小不超过 5MB。头像公开显示。
            </p>
          )}

          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-display-name">昵称</Label>
                <span className="font-mono text-xs text-muted-foreground">
                  {displayName.trim().length}/30
                </span>
              </div>
              <Input
                id="profile-display-name"
                value={displayName}
                maxLength={30}
                placeholder="给自己起一个名字"
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                昵称不要求唯一。未设置时会显示邮箱。
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="profile-bio">个人简介</Label>
                <span className="font-mono text-xs text-muted-foreground">
                  {bio.trim().length}/160
                </span>
              </div>
              <Textarea
                id="profile-bio"
                value={bio}
                maxLength={160}
                rows={3}
                placeholder="简单介绍一下自己（选填）"
                onChange={(event) => setBio(event.target.value)}
              />
            </div>
          </div>

          {saveError ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {saveError}
            </p>
          ) : null}

          <div className="flex items-center justify-end border-t border-border/60 pt-5">
            <Button type="button" disabled={!dirty || saving} onClick={() => void saveProfile()}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : null}
              {saving ? "保存中..." : "保存资料"}
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-mono text-base font-semibold text-foreground">账号信息</h2>
        </div>
        <div className="grid gap-3 px-5 py-5 sm:grid-cols-2">
          <div className="rounded-md border border-border bg-background px-3 py-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mail size={13} /> 邮箱
            </p>
            <p className="mt-2 break-all font-mono text-sm text-foreground">{email}</p>
          </div>
          <div className="rounded-md border border-border bg-background px-3 py-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays size={13} /> 注册时间
            </p>
            <p className="mt-2 font-mono text-sm text-foreground">{formatProfileDate(profile?.createdAt)}</p>
          </div>
        </div>
      </section>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认移除头像？</AlertDialogTitle>
            <AlertDialogDescription>
              移除后将显示昵称或邮箱生成的默认头像。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(event) => {
                event.preventDefault();
                void removeAvatar();
              }}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatProfileDate(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
