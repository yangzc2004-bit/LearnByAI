"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Info, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

const ACCOUNT_NAV_ITEMS = [
  { href: "/account/profile", label: "个人资料", icon: UserRound },
  { href: "/account/about", label: "关于", icon: Info },
] as const;

export function AccountNav() {
  const pathname = usePathname();

  return (
    <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
      {ACCOUNT_NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon size={15} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
