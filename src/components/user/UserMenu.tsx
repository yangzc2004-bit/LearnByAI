"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Info, LogOut, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./UserAvatar";
import { useUserSession } from "./UserSessionProvider";

type UserMenuProps = {
  className?: string;
  mobile?: boolean;
};

export function UserMenu({ className, mobile = false }: UserMenuProps) {
  const router = useRouter();
  const { user, profile } = useUserSession();

  if (!user) return null;

  const displayName =
    profile?.displayName?.trim() ||
    user.email?.split("@")[0] ||
    "我的账户";

  async function logout() {
    const supabase = createSupabaseBrowserClient();
    await supabase?.auth.signOut();
    router.replace("/");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-none",
            mobile ? "w-full" : "max-w-[190px]",
            className,
          )}
        >
          <UserAvatar profile={profile} email={user.email} className="size-7 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {displayName}
          </span>
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={mobile ? "start" : "end"} sideOffset={8} className="w-64">
        <DropdownMenuLabel className="flex items-center gap-3 px-2 py-2.5">
          <UserAvatar profile={profile} email={user.email} className="size-10" fallbackClassName="text-sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
            {user.email ? (
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{user.email}</p>
            ) : null}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account/profile" className="cursor-pointer">
            <UserRound size={16} />
            个人资料
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/about" className="cursor-pointer">
            <Info size={16} />
            关于
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void logout()}>
          <LogOut size={16} />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
