"use client";

import Link from "next/link";
import { useOrganization } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { BarChart3, CalendarDays, CheckCircle2, Radio } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { PageHeader } from "@/components/shared/page-header";
import { insightService } from "@/features/ai/services/insight-service";

export function InsightsPage() {
  const { organization } = useOrganization();
  const insights = useQuery(
    insightService.getInsights,
    organization?.id ? { orgId: organization.id } : "skip",
  );

  if (insights === undefined) {
    return <LoadingBlock className="h-72 w-full" />;
  }

  const totals = [
    { label: "Total meetings", value: insights.totals.meetings, icon: CalendarDays, tone: "bg-primary/15 text-brand" },
    { label: "Active", value: insights.totals.active, icon: Radio, tone: "bg-emerald-500/15 text-emerald-400" },
    { label: "Ended", value: insights.totals.ended, icon: CheckCircle2, tone: "bg-sky-500/15 text-sky-400" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={BarChart3}
        eyebrow="Analytics"
        title="Insights"
        description="Live metrics from the meetings in your workspace."
      />

      <div className="grid gap-4 md:grid-cols-3">
        {totals.map((item) => (
          <Card key={item.label} className="border-border">
            <CardContent className="flex items-center gap-4">
              <span className={`flex size-11 items-center justify-center rounded-xl ${item.tone}`}>
                <item.icon className="size-5" />
              </span>
              <div>
                <p className="text-3xl font-bold tracking-tight text-foreground tabular-nums">{item.value}</p>
                <p className="text-sm text-muted-foreground">{item.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border">
        <CardHeader>
          <CardTitle>Meeting timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {insights.timeline.length === 0 ? (
            <EmptyState title="No insight data yet" description="Run meetings to populate analytics." />
          ) : (
            insights.timeline.map((meeting) => (
              <Link
                key={meeting.id}
                href={`/meeting/${meeting.id}/details`}
                className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm transition-colors hover:bg-muted/50"
              >
                <span className="font-medium text-foreground">{meeting.title}</span>
                <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {meeting.status}
                </span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
