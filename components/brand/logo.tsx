import { useId } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { SITE_NAME } from "@/lib/site";

/**
 * The Meetup mark: two people (head + shoulders) whose shoulders join into an "M".
 * The warm head is the person who just "met up".
 * Keep in sync with public/logo.svg and app/icon.svg.
 */
export function LogoMark({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, "");

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("size-9 shrink-0", className)}
    >
      <defs>
        <linearGradient id={`${uid}-tile`} x1="6" y1="2" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9277FF" />
          <stop offset="1" stopColor="#4A34DA" />
        </linearGradient>
        <linearGradient id={`${uid}-warm`} x1="35" y1="10" x2="45" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFCB70" />
          <stop offset="1" stopColor="#FF7552" />
        </linearGradient>
        <radialGradient
          id={`${uid}-glow`}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(18 8) rotate(50) scale(52)"
        >
          <stop stopColor="#fff" stopOpacity=".28" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${uid}-tile)`} />
      <rect width="64" height="64" rx="15" fill={`url(#${uid}-glow)`} />
      <path
        d="M16 49V35a8 8 0 0 1 16 0v14M32 35a8 8 0 0 1 16 0v14"
        stroke="#fff"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="17" r="4.6" fill="#fff" />
      <circle cx="40" cy="17" r="4.6" fill={`url(#${uid}-warm)`} />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-display text-[1.15rem] leading-none font-extrabold tracking-[-0.04em] text-foreground",
        className,
      )}
    >
      meet<span className="text-brand">up</span>
    </span>
  );
}

const SIZES = {
  sm: { mark: "size-7", word: "text-base" },
  md: { mark: "size-9", word: "text-[1.15rem]" },
  lg: { mark: "size-11", word: "text-2xl" },
} as const;

interface LogoProps {
  /** Where the logo links to. Pass `null` to render it without a link. */
  href?: string | null;
  size?: keyof typeof SIZES;
  /** Optional small line under the wordmark (e.g. "Workspace"). */
  caption?: string;
  className?: string;
  onClick?: () => void;
}

export function Logo({ href = "/", size = "md", caption, className, onClick }: LogoProps) {
  const dims = SIZES[size];
  const content = (
    <>
      <LogoMark className={cn("transition-transform duration-300 group-hover/logo:scale-105", dims.mark)} />
      <span className="flex flex-col justify-center gap-1">
        <Wordmark className={dims.word} />
        {caption ? (
          <span className="text-[11px] leading-none font-medium text-muted-foreground">{caption}</span>
        ) : null}
      </span>
    </>
  );

  const classes = cn("group/logo inline-flex items-center gap-2.5", className);

  if (href === null) {
    return <span className={classes}>{content}</span>;
  }

  return (
    <Link href={href} onClick={onClick} className={classes} aria-label={`${SITE_NAME} home`}>
      {content}
    </Link>
  );
}
