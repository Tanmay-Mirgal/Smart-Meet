"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { Logo } from "@/components/brand/logo";
import { APP_NAV_ITEMS, isNavItemActive } from "@/lib/app-nav";
import { cn } from "@/lib/utils";

export const orgSwitcherAppearance = {
  elements: {
    rootBox: "w-full",
    organizationSwitcherTrigger:
      "w-full justify-start rounded-xl border border-border bg-background/60 px-3 py-2 text-sm transition-colors hover:bg-muted/60",
  },
} as const;

export const userButtonAppearance = {
  elements: {
    userButtonAvatarBox: "h-8 w-8 rounded-lg",
  },
} as const;

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Workspace" className="flex flex-col gap-0.5">
      {APP_NAV_ITEMS.map((item) => {
        const isActive = isNavItemActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-150",
              isActive
                ? "bg-sidebar-accent font-semibold text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            {isActive ? (
              <span
                className="absolute top-1/2 left-0 h-5 w-1 -translate-y-1/2 rounded-r-full bg-brand-gradient"
                aria-hidden="true"
              />
            ) : null}
            <item.icon
              className={cn(
                "size-4 shrink-0 transition-colors",
                isActive ? "text-brand" : "text-muted-foreground group-hover:text-foreground",
              )}
            />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppSidebar() {
  return (
    <aside className="hidden h-screen w-64 shrink-0 self-start border-r border-sidebar-border bg-sidebar lg:sticky lg:top-0 lg:flex lg:flex-col">
      <div className="px-5 pt-5 pb-4">
        <Logo href="/dashboard" caption="Workspace" />
      </div>

      <div className="px-4 pb-4">
        <OrganizationSwitcher hidePersonal appearance={orgSwitcherAppearance} />
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">
        <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground/60 uppercase">
          Navigation
        </p>
        <NavLinks />
      </div>

      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3 rounded-xl px-1 py-1">
          <UserButton appearance={userButtonAppearance} />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Account</p>
            <p className="text-xs text-muted-foreground">Manage profile</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
