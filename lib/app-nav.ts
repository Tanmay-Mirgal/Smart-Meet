import {
  CalendarDays,
  CreditCard,
  FileText,
  LayoutDashboard,
  ListChecks,
  Plug,
  type LucideIcon,
} from "lucide-react";

export interface AppNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Primary navigation shared by the desktop sidebar and the mobile drawer. */
export const APP_NAV_ITEMS: ReadonlyArray<AppNavItem> = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/meetings", label: "Meetings", icon: CalendarDays },
  { href: "/tasks", label: "Tasks Board", icon: ListChecks },
  { href: "/minutes-of-meetings", label: "Minutes of Meetings", icon: FileText },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/billing", label: "Billing", icon: CreditCard },
];

export function isNavItemActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}
