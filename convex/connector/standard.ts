/**
 * Schemas for the CP1 standard endpoints (§4) — shared by the router (runtime
 * validation) and the OpenAPI generator.
 */
import { z } from "zod";
import { externalRefSchema, isValidEventPattern, paginationQuery } from "./registry";

const iso = z.iso.datetime();

export const eventPatternSchema = z
  .string()
  .max(64)
  .refine(isValidEventPattern, {
    message: "Must be an event type (e.g. meeting.ended) or a prefix pattern (e.g. meeting.*)",
  })
  .meta({ description: "Exact event type or `prefix.*`", examples: ["meeting.*", "task.completed"] });

export const webhookCreateInput = z
  .strictObject({
    url: z.url().max(2000).meta({
      description: "HTTPS endpoint that receives signed POSTs. Private/loopback addresses are rejected.",
      examples: ["https://hub.example.com/hooks/meetup"],
    }),
    events: z.array(eventPatternSchema).min(1).max(20),
    description: z.string().max(200).optional(),
  })
  .meta({ title: "Webhook registration" });

export const webhookPatchInput = z
  .strictObject({
    url: z.url().max(2000).optional(),
    events: z.array(eventPatternSchema).min(1).max(20).optional(),
    description: z.string().max(200).optional(),
    status: z.enum(["active", "disabled"]).optional().meta({
      description: "Set to active to re-enable an endpoint that was disabled.",
    }),
  })
  .meta({ title: "Webhook update" });

export const webhookEntity = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  description: z.string().optional(),
  status: z.enum(["active", "disabled"]),
  disabledReason: z.string().optional(),
  consecutiveFailures: z.number(),
  lastDeliveryAt: iso.optional(),
  lastDeliveryStatus: z.enum(["succeeded", "failed"]).optional(),
  createdAt: iso,
  updatedAt: iso,
});

export const webhookCreated = webhookEntity.extend({
  secret: z.string().meta({ description: "Signing secret (whsec_…). Returned ONCE — store it now." }),
});

export const deliveryEntity = z.object({
  id: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(["pending", "succeeded", "failed", "cancelled"]),
  attempts: z.number(),
  nextAttemptAt: iso.optional(),
  lastAttemptAt: iso.optional(),
  lastResponseCode: z.number().optional(),
  lastResponseBody: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: iso,
  finishedAt: iso.optional(),
});

export const eventEnvelope = z
  .object({
    id: z.string().meta({ examples: ["evt_01J9ZK3Q5W8X0A2B4C6D8E0F1G"] }),
    type: z.string(),
    apiVersion: z.literal("cp1"),
    service: z.literal("meetup"),
    occurredAt: iso,
    tenantId: z.string(),
    actor: z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["user", "system", "connector"]),
    }),
    externalRef: externalRefSchema.optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ title: "Event" });

export const eventsQuery = z.strictObject({
  ...paginationQuery,
  types: z.string().max(500).optional().meta({
    description: "Comma-separated event types or prefix patterns to include.",
    examples: ["meeting.*,task.completed"],
  }),
});

export const operationEntity = z.object({
  id: z.string(),
  action: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
  output: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: iso,
  finishedAt: iso.optional(),
});

export const meOutput = z.object({
  user: z.object({ id: z.string(), email: z.string().nullable(), name: z.string() }),
  tenant: z.object({ id: z.string(), name: z.string(), kind: z.literal("organization") }),
  scopes: z.array(z.string()),
  grantId: z.string(),
  plan: z.object({
    name: z.string(),
    limits: z.object({ maxMeetings: z.number().nullable() }),
    usage: z.object({ meetingsUsed: z.number(), meetingsRemaining: z.number().nullable() }),
  }),
  capabilities: z.object({
    aiSummary: z.boolean(),
    recording: z.boolean(),
    notionExport: z.boolean(),
    googleCalendarSync: z.boolean(),
    meetingsUsed: z.number(),
    meetingsCap: z.number().nullable(),
  }),
});

export const tokenResponse = z.object({
  token_type: z.literal("Bearer"),
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
  tenant: z.object({ id: z.string(), name: z.string(), kind: z.literal("organization") }),
  user: z.object({ id: z.string(), email: z.string().nullable(), name: z.string() }),
});

export const idempotencyKeySchema = z.string().min(1).max(128);
