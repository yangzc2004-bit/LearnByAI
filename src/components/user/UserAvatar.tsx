"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { UserProfile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DefaultBotAvatar } from "./DefaultBotAvatar";

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
      <AvatarFallback
        className={cn(
          "bg-gradient-to-br from-muted to-muted-foreground/15 text-muted-foreground",
          fallbackClassName,
        )}
      >
        <DefaultBotAvatar className="size-[58%]" />
      </AvatarFallback>
    </Avatar>
  );
}
