"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  profile?: UserProfile | null;
  email?: string | null;
  avatarUrl?: string | null;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
};

export function UserAvatar({
  profile,
  email,
  avatarUrl,
  className,
  imageClassName,
  fallbackClassName,
}: UserAvatarProps) {
  const source = avatarUrl ?? profile?.avatarUrl;
  const displayName = profile?.displayName?.trim();
  const fallback = avatarFallback(displayName, email ?? profile?.email);

  return (
    <Avatar className={cn("size-8", className)}>
      {source ? (
        <AvatarImage
          key={source}
          src={source}
          alt={displayName || email || "用户头像"}
          className={cn("object-cover", imageClassName)}
        />
      ) : null}
      <AvatarFallback className={cn("font-mono text-xs", fallbackClassName)}>
        {fallback}
      </AvatarFallback>
    </Avatar>
  );
}

function avatarFallback(displayName: string | undefined, email: string | null | undefined) {
  const name = displayName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${firstGlyph(parts[0])}${firstGlyph(parts[1])}`.toUpperCase();
    }
    return firstGlyph(name).toUpperCase();
  }

  const localPart = email?.trim().split("@")[0];
  if (localPart) return firstGlyph(localPart).toUpperCase();

  return "学";
}

function firstGlyph(value: string) {
  return Array.from(value.trim())[0] ?? "";
}
