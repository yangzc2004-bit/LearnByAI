import { cn } from "@/lib/utils";

type DefaultBotAvatarProps = {
  className?: string;
};

/**
 * The LearnByAI default avatar: a small rounded bot face.
 * It is rendered as inline SVG so it stays crisp in the 28px nav avatar,
 * the 96px profile avatar and any future sizing.
 */
export function DefaultBotAvatar({ className }: DefaultBotAvatarProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("size-full", className)}
    >
      {/* antenna */}
      <path
        d="M32 26V17"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <circle cx="32" cy="12.5" r="4.5" fill="currentColor" />

      {/* side ears */}
      <rect x="7" y="31" width="5" height="15" rx="2.5" fill="currentColor" opacity="0.85" />
      <rect x="52" y="31" width="5" height="15" rx="2.5" fill="currentColor" opacity="0.85" />

      {/* head */}
      <rect
        x="12"
        y="26"
        width="40"
        height="27"
        rx="10"
        stroke="currentColor"
        strokeWidth="3.5"
      />

      {/* eyes */}
      <circle cx="25" cy="39.5" r="3.2" fill="currentColor" />
      <circle cx="39" cy="39.5" r="3.2" fill="currentColor" />

      {/* smile */}
      <path
        d="M23.5 46.5c2.8 2.9 14.2 2.9 17 0"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
