"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AccountNav } from "@/components/user/AccountNav";
import { useUserSession } from "@/components/user/UserSessionProvider";
import { isSupabaseAuthEnabled } from "@/lib/hooks/useUser";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useUserSession();
  const authEnabled = isSupabaseAuthEnabled();

  useEffect(() => {
    if (!authEnabled || user === undefined || user !== null) return;
    const next = `/login?next=${encodeURIComponent(pathname)}`;
    router.replace(next);
  }, [authEnabled, user, router, pathname]);

  if (authEnabled && (user === undefined || user === null)) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center bg-background px-4">
        <p className="text-sm text-muted-foreground">
          {user === null ? "正在前往登录..." : "正在验证登录状态..."}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <h1 className="font-mono text-2xl font-bold text-foreground">账户设置</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            管理你的个人资料和模型设置。
          </p>
        </div>

        <div className="flex flex-col gap-8 md:flex-row">
          <aside>
            <AccountNav />
          </aside>
          <main className="min-w-0 flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}
