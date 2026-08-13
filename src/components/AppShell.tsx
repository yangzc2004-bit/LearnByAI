"use client";

import { usePathname } from "next/navigation";
import { ModelConfigWarning } from "./ModelConfigWarning";
import { Navigation } from "./Navigation";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAdmin = pathname === "/admin" || pathname?.startsWith("/admin/");
  // The internal print route renders a bare, chrome-free document for PDF export.
  const isBare = pathname?.startsWith("/internal/print");

  if (isBare) return <>{children}</>;

  // The reader page renders its own full-viewport chrome (and Navigation itself
  // returns null on /chapters/), so skip the global nav + its pt-14 offset there —
  // otherwise the chapter's h-screen layout gets pushed down 56px and leaves a
  // scrollable blank gap above the reader header.
  const isChapter = pathname?.includes("/chapters/");
  const showChrome = !isAdmin && !isChapter;

  return (
    <>
      {showChrome && <Navigation />}
      <div className={showChrome ? "pt-14" : ""}>
        {showChrome && <ModelConfigWarning />}
        {children}
      </div>
    </>
  );
}
