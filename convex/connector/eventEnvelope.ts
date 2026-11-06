import type { Doc } from "../_generated/dataModel";
import { iso } from "./entities";

/**
 * The CP1 event envelope (§5). Used for BOTH webhook bodies and `GET /events`,
 * so the polling log can never disagree with what was delivered (C20).
 */
export function toEnvelope(event: Doc<"connector_events">) {
  return {
    id: event.eventId,
    type: event.type,
    apiVersion: "cp1" as const,
    service: "meetup" as const,
    occurredAt: iso(event.occurredAt),
    tenantId: event.orgId,
    actor: event.actor,
    // Always present (empty when the entity carries no correlation ids).
    externalRef: event.externalRef ?? {},
    data: event.data as Record<string, unknown>,
  };
}
