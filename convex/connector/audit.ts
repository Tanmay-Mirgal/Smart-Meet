import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type AuditEntry = {
  grant: Pick<
    Doc<"connector_grants">,
    "_id" | "clientId" | "orgId" | "userTokenIdentifier"
  >;
  /** Action or resource name, e.g. `meetings.create` or `meetings.get`. */
  action: string;
  method: string;
  status: number;
  requestId: string;
  errorCode?: string;
  meetingId?: Id<"meetings">;
};

/**
 * CP1 §6: every connector call is logged `via: "connector"` with client id,
 * grant id, action name and request id. Payloads are never stored.
 */
export async function writeAudit(ctx: MutationCtx, entry: AuditEntry, now: number) {
  await ctx.db.insert("connector_audit", {
    orgId: entry.grant.orgId,
    grantId: entry.grant._id,
    clientId: entry.grant.clientId,
    userTokenIdentifier: entry.grant.userTokenIdentifier,
    via: "connector",
    action: entry.action,
    method: entry.method,
    status: entry.status,
    ok: entry.status < 400,
    errorCode: entry.errorCode,
    requestId: entry.requestId,
    meetingId: entry.meetingId,
    createdAt: now,
  });
}
