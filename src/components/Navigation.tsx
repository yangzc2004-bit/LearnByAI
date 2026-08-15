"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Menu, Sparkles, X } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./user/UserMenu";
import { useUserSession } from "./user/UserSessionProvider";

export function Navigation() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const { user } = useUserSession();

  if (pathname?.includes("/chapters/")) {
    return null;
  }

  const navLinks = [
    { label: "首页", href: "/" },
    { label: "课程", href: "/courses" },
    { label: "创建", href: "/create/mode" },
    { label: "模型设置", href: "/model" },
  ];

  const isActive = (href: string) =>
    pathname === href || (pathname?.startsWith(href) && href !== "/");

  return (
    <nav className="fixed left-0 right-0 top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-foreground transition-opacity hover:opacity-80"
        >
          <BookOpen size={20} className="text-primary" />
          <span className="font-mono text-base font-bold tracking-tight">LearnByAI</span>
          <Sparkles size={14} className="text-yellow-500" />
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm font-mono tracking-wider transition-colors hover:text-primary ${
                isActive(link.href) ? "font-medium text-primary" : "text-muted-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
          {user === undefined ? null : user ? (
            <UserMenu />
          ) : (
            <Link
              href="/login"
              className={`text-sm font-mono tracking-wider transition-colors hover:text-primary ${isActive("/login") ? "font-medium text-primary" : "text-muted-foreground"}`}
            >
              登录 / 注册
            </Link>
          )}
          <ThemeToggle />
        </div>

        <button
          type="button"
          className="p-2 -mr-2 md:hidden"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? "关闭导航菜单" : "打开导航菜单"}
        >
          {mobileOpen ? (
            <X size={22} className="text-foreground" />
          ) : (
            <Menu size={22} className="text-foreground" />
          )}
        </button>
      </div>

      {mobileOpen && (
        <div className="border-t border-border bg-background px-4 py-4 md:hidden">
          <div className="flex flex-col gap-3">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`block py-2 text-sm font-mono tracking-wider ${
                  isActive(link.href) ? "font-medium text-primary" : "text-muted-foreground"
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <div className="border-t border-border/50 pt-3">
                <UserMenu mobile />
              </div>
            ) : user === null ? (
              <Link
                href="/login"
                onClick={() => setMobileOpen(false)}
                className="block border-t border-border/50 pt-3 text-sm font-mono tracking-wider text-muted-foreground"
              >
                登录 / 注册
              </Link>
            ) : null}
            <div className="border-t border-border/50 pt-4">
              <ThemeToggle />
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
