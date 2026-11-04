"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { OrganizationSwitcher, UserButton, useOrganization } from "@clerk/nextjs";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import {
  AppSidebar,
  NavLinks,
  orgSwitcherAppearance,
  userButtonAppearance,
} from "@/components/shared/app-sidebar";
import { LoadingBlock } from "@/components/shared/loading-block";
import { NotificationBell } from "@/components/layout/notification-bell";
import { CreateMeetingDialog } from "@/features/meeting/components/create-meeting-dialog";
import { useSyncOrganizationBilling } from "@/features/billing/hooks/use-sync-organization-billing";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { APP_NAV_ITEMS, isNavItemActive } from "@/lib/app-nav";

function DashboardHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const currentPage =
    APP_NAV_ITEMS.find((item) => isNavItemActive(pathname, item.href))?.label ?? "Dashboard";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/75 px-4 backdrop-blur-xl lg:px-6">
      <div className="flex items-center gap-3">
        <Drawer direction="left" open={open} onOpenChange={setOpen}>
          <DrawerTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 lg:hidden"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </Button>
          </DrawerTrigger>

          <DrawerContent className="flex h-full w-72 flex-col bg-sidebar p-0">
            <DrawerTitle className="sr-only">Navigation</DrawerTitle>
            <DrawerDescription className="sr-only">
              Move between your Meetup workspace pages.
            </DrawerDescription>

            <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-4">
              <Logo href="/dashboard" caption="Workspace" onClick={() => setOpen(false)} />
              <DrawerClose asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close navigation">
                  <X className="h-4 w-4" />
                </Button>
              </DrawerClose>
            </div>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
              <OrganizationSwitcher hidePersonal appearance={orgSwitcherAppearance} />
              <NavLinks onNavigate={() => setOpen(false)} />
            </div>

            <div className="border-t border-sidebar-border px-4 py-4">
              <div className="flex items-center gap-3">
                <UserButton appearance={userButtonAppearance} />
                <div>
                  <p className="text-sm text-foreground">Account</p>
                  <p className="text-xs text-muted-foreground">Manage profile</p>
                </div>
              </div>
            </div>

            <div className="border-t border-sidebar-border px-4 py-3">
              <CreateMeetingDialog triggerLabel="Start Meeting" />
            </div>
          </DrawerContent>
        </Drawer>

        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground lg:inline">Workspace</span>
          <span className="hidden text-xs text-muted-foreground/60 lg:inline">/</span>
          <span className="font-display text-sm font-semibold text-foreground">{currentPage}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden lg:block">
          <CreateMeetingDialog triggerLabel="Start Meeting" />
        </div>
        <NotificationBell />
      </div>
    </header>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isLoaded, organization } = useOrganization();
  useSyncOrganizationBilling(organization?.id);

  useEffect(() => {
    if (isLoaded && !organization) {
      router.push("/onboarding");
    }
  }, [isLoaded, organization, router]);

  if (!isLoaded) {
    return (
      <div className="p-8">
        <LoadingBlock className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader />
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
