import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { RESOURCES } from "./registry";
import type { Route } from "./routes";
import { parseInput, wantsIgnoreUnknown } from "./validate";

type ResourceRoute = Extract<Route, { kind: "resource" }>;

type PageQuery = { limit: number; cursor?: string };

function toMillis(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Date.parse(value);
}

/**
 * Runs a GET resource: validates the query string against the registry schema
 * (the same one that generated the manifest), then calls the matching
 * `exec.*` query, which re-checks the grant, the tenant and the user.
 */
export async function runResource(
  ctx: ActionCtx,
  route: ResourceRoute,
  request: Request,
  grantId: Id<"connector_grants">,
  now: number,
): Promise<unknown> {
  const definition = RESOURCES.find((resource) => resource.name === route.name);
  if (!definition) throw new Error(`Unregistered resource ${route.name}`);

  const rawQuery = Object.fromEntries(new URL(request.url).searchParams.entries());
  const query = parseInput(definition.query, rawQuery, wantsIgnoreUnknown(request)) as Record<
    string,
    string | number | undefined
  >;
  const common = { grantId, now };
  const id = route.params.id ?? "";
  const paging: PageQuery = {
    limit: Number(query.limit ?? 50),
    cursor: query.cursor as string | undefined,
  };

  switch (route.name) {
    case "orgs.get":
      return await ctx.runQuery(internal.connector.exec.orgsGet, common);
    case "members.list":
      return await ctx.runQuery(internal.connector.exec.membersList, { ...common, ...paging });
    case "meetings.list":
      return await ctx.runQuery(internal.connector.exec.meetingsList, {
        ...common,
        ...paging,
        status: query.status as "scheduled" | "active" | "ended" | undefined,
        purpose: query.purpose as string | undefined,
        from: toMillis(query.from as string | undefined),
        to: toMillis(query.to as string | undefined),
      });
    case "meetings.get":
      return await ctx.runQuery(internal.connector.exec.meetingsGet, { ...common, id });
    case "meetings.participants":
      return await ctx.runQuery(internal.connector.exec.meetingsParticipants, {
        ...common,
        ...paging,
        id,
      });
    case "meetings.transcript":
      return await ctx.runQuery(internal.connector.exec.meetingsTranscript, {
        ...common,
        ...paging,
        id,
      });
    case "meetings.summary":
      return await ctx.runQuery(internal.connector.exec.meetingsSummary, { ...common, id });
    case "meetings.recordings":
      return await ctx.runQuery(internal.connector.exec.meetingsRecordings, {
        ...common,
        ...paging,
        id,
      });
    case "meetings.whiteboard":
      return await ctx.runQuery(internal.connector.exec.meetingsWhiteboard, { ...common, id });
    case "tasks.list":
      return await ctx.runQuery(internal.connector.exec.tasksList, {
        ...common,
        ...paging,
        status: query.status as "open" | "in_progress" | "done" | undefined,
        meetingId: query.meetingId as string | undefined,
        assigneeEmail: query.assigneeEmail as string | undefined,
      });
    case "insights.get":
      return await ctx.runQuery(internal.connector.exec.insightsGet, {
        ...common,
        range: query.range as "7d" | "30d" | "90d" | "all",
      });
  }
}
