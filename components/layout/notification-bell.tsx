'use client';

import React, { useEffect, useRef } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useOrganization, useUser } from '@clerk/nextjs';
import { Bell } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

function getInitials(message: string): string {
  // Try to extract a name from the message like "Tanmay Mirgal started fg"
  const match = message.match(/^([A-Za-z]+)\s+([A-Za-z]+)/);
  if (match) {
    return `${match[1][0]}${match[2][0]}`.toUpperCase();
  }
  return message.charAt(0).toUpperCase();
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function NotificationBell() {
  const { organization } = useOrganization();
  const { user } = useUser();
  const markRead = useMutation(api.notifications.index.markRead);
  const markAllRead = useMutation(api.notifications.index.markAllRead);
  const hasHydratedRef = useRef(false);
  const seenNotificationIdsRef = useRef(new Set<string>());

  const notifications = useQuery(
    api.notifications.index.list,
    organization?.id ? { orgId: organization.id } : 'skip',
  );

  // Mark existing as seen on first load (no toast spam)
  useEffect(() => {
    if (!notifications || hasHydratedRef.current) return;
    notifications.forEach((n) => seenNotificationIdsRef.current.add(n._id));
    hasHydratedRef.current = true;
  }, [notifications]);

  if (!organization || !user) return null;

  const unreadCount = notifications?.filter((n) => !n.isRead).length ?? 0;

  const handleOpenChange = (open: boolean) => {
    if (open && organization && (unreadCount > 0)) {
      void markAllRead({ orgId: organization.id });
    }
  };

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9">
          <Bell className="h-4.5 w-4.5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-[340px] overflow-hidden rounded-xl border border-border p-0 shadow-xl"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {unreadCount > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-brand">
              {unreadCount} unread
            </span>
          )}
        </div>

        {/* Body */}
        <div className="max-h-[360px] overflow-y-auto">
          {notifications === undefined ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Bell className="h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm font-medium text-foreground">All caught up</p>
              <p className="text-xs text-muted-foreground">No new notifications</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {notifications.map((notification) => {
                const initials = getInitials(notification.message);
                return (
                  <div
                    key={notification._id}
                    className={`flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40 ${
                      !notification.isRead ? 'bg-primary/5' : ''
                    }`}
                    onClick={() => {
                      if (!notification.isRead) {
                        void markRead({ notificationId: notification._id });
                      }
                    }}
                  >
                    {/* Avatar */}
                    <Avatar className="mt-0.5 h-8 w-8 shrink-0 border border-border/50">
                      <AvatarFallback className="bg-primary/10 text-[11px] font-bold text-brand">
                        {initials}
                      </AvatarFallback>
                    </Avatar>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-[13px] leading-snug ${
                          !notification.isRead
                            ? 'font-medium text-foreground'
                            : 'text-muted-foreground'
                        }`}
                      >
                        {notification.message}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                        {timeAgo(notification.createdAt)}
                      </p>
                    </div>

                    {/* Unread dot */}
                    {!notification.isRead && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
