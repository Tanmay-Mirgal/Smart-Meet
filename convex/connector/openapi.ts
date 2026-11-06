import { z } from "zod";
import {
  CONNECTOR_DISPLAY_NAME,
  CONNECTOR_VERSION,
  LIMITS,
  PUBLIC_API_PREFIX,
} from "./config";
import { ACTIONS, RESOURCES, toJsonSchema } from "./registry";
import { SCOPE_DEFINITIONS } from "./scopes";
import {
  deliveryEntity,
  eventEnvelope,
  eventsQuery,
  meOutput,
  operationEntity,
  tokenResponse,
  webhookCreateInput,
  webhookCreated,
  webhookEntity,
  webhookPatchInput,
} from "./standard";

type Json = Record<string, unknown>;

/** OpenAPI 3.1 speaks JSON Schema 2020-12 natively; only the `$schema` marker is noise. */
function schemaOf(schema: z.ZodType, io: "input" | "output" = "output"): Json {
  const { $schema: _ignored, ...rest } = toJsonSchema(schema, io);
  void _ignored;
  return rest;
}

const errorResponses: Json = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", maxLength: 128 },
  description:
    "Replays the stored response for 24 h when the same key and body are sent again; a different body with the same key returns 422 idempotency_conflict.",
};

function queryParameters(schema: z.ZodType): Json[] {
  const json = schemaOf(schema, "input") as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: json.required?.includes(name) ?? false,
    schema: propSchema,
  }));
}

function pathParameters(path: string): Json[] {
  return Array.from(path.matchAll(/\{(\w+)\}/g)).map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

export function buildOpenApi({ appUrl }: { appUrl: string }) {
  const paths: Record<string, Json> = {
    "/health": {
      get: {
        operationId: "health",
        summary: "Liveness probe (no auth)",
        security: [],
        responses: { "200": { description: "OK" } },
      },
    },
    "/manifest": {
      get: {
        operationId: "manifest",
        summary: "CP1 discovery document (no auth)",
        security: [],
        responses: { "200": { description: "The manifest" } },
      },
    },
    "/me": {
      get: {
        operationId: "me",
        summary: "The connected user, tenant, scopes, plan and capabilities",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: schemaOf(meOutput) } } },
          ...errorResponses,
        },
      },
    },
    "/oauth/token": {
      post: {
        operationId: "oauthToken",
        summary: "Exchange an authorization code or refresh token",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": { schema: { type: "object" } },
            "application/json": { schema: { type: "object" } },
          },
        },
        responses: {
          "200": { description: "Tokens", content: { "application/json": { schema: schemaOf(tokenResponse) } } },
          "400": { description: "RFC 6749 error" },
          "401": { description: "invalid_client" },
        },
      },
    },
    "/oauth/revoke": {
      post: {
        operationId: "oauthRevoke",
        summary: "Revoke a token (RFC 7009) — always 200",
        security: [],
        requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } } },
        responses: { "200": { description: "Revoked (or unknown)" } },
      },
    },
    "/operations/{id}": {
      get: {
        operationId: "getOperation",
        summary: "Poll an asynchronous action",
        parameters: pathParameters("/operations/{id}"),
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: schemaOf(operationEntity) } } },
          ...errorResponses,
        },
      },
    },
    "/webhooks": {
      post: {
        operationId: "createWebhook",
        summary: "Register a webhook endpoint (secret returned once)",
        parameters: [idempotencyHeader],
        requestBody: { required: true, content: { "application/json": { schema: schemaOf(webhookCreateInput, "input") } } },
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: schemaOf(webhookCreated) } } },
          ...errorResponses,
        },
      },
      get: {
        operationId: "listWebhooks",
        summary: "List this connection's webhook endpoints",
        responses: { "200": { description: "OK" }, ...errorResponses },
      },
    },
    "/webhooks/{id}": {
      get: {
        operationId: "getWebhook",
        parameters: pathParameters("/webhooks/{id}"),
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: schemaOf(webhookEntity) } } },
          ...errorResponses,
        },
      },
      patch: {
        operationId: "updateWebhook",
        parameters: pathParameters("/webhooks/{id}"),
        requestBody: { required: true, content: { "application/json": { schema: schemaOf(webhookPatchInput, "input") } } },
        responses: { "200": { description: "OK" }, ...errorResponses },
      },
      delete: {
        operationId: "deleteWebhook",
        parameters: pathParameters("/webhooks/{id}"),
        responses: { "204": { description: "Deleted" }, ...errorResponses },
      },
    },
    "/webhooks/{id}/deliveries": {
      get: {
        operationId: "listDeliveries",
        summary: "Delivery log",
        parameters: pathParameters("/webhooks/{id}/deliveries"),
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", properties: { items: { type: "array", items: schemaOf(deliveryEntity) }, nextCursor: { type: ["string", "null"] } } },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/webhooks/{id}/deliveries/{deliveryId}/redeliver": {
      post: {
        operationId: "redeliver",
        summary: "Replay a delivery",
        parameters: pathParameters("/webhooks/{id}/deliveries/{deliveryId}/redeliver"),
        responses: { "202": { description: "Queued" }, ...errorResponses },
      },
    },
    "/events": {
      get: {
        operationId: "listEvents",
        summary: "Polling fallback — the organization's event log in order",
        parameters: queryParameters(eventsQuery),
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", properties: { items: { type: "array", items: schemaOf(eventEnvelope) }, nextCursor: { type: ["string", "null"] } } },
              },
            },
          },
          ...errorResponses,
        },
      },
    },
  };

  for (const action of ACTIONS) {
    paths[`/actions/${action.name}`] = {
      post: {
        operationId: `action_${action.name.replace(/\./g, "_")}`,
        summary: action.description,
        "x-scopes": [...action.scopes],
        "x-async": action.async,
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["input"],
                additionalProperties: false,
                properties: { input: schemaOf(action.input, "input") },
              },
            },
          },
        },
        responses: action.async
          ? {
              "202": {
                description: "Accepted — poll the operation",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        operation: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            status: { const: "pending" },
                            pollUrl: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              ...errorResponses,
            }
          : {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { output: schemaOf(action.output) } },
                  },
                },
              },
              ...errorResponses,
              "402": { $ref: "#/components/responses/Error" },
              "412": { $ref: "#/components/responses/Error" },
              "422": { $ref: "#/components/responses/Error" },
            },
      },
    };
  }

  for (const resource of RESOURCES) {
    paths[resource.path] = {
      get: {
        operationId: `resource_${resource.name.replace(/\./g, "_")}`,
        summary: resource.description,
        "x-scopes": [...resource.scopes],
        parameters: [...pathParameters(resource.path), ...queryParameters(resource.query)],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: schemaOf(resource.output) } } },
          ...errorResponses,
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${CONNECTOR_DISPLAY_NAME} Connector (CP1)`,
      version: CONNECTOR_VERSION,
      description:
        "Ecosystem Connector Protocol v1 for Meetup. Server-to-server only; no CORS.",
    },
    servers: [{ url: `${appUrl}${PUBLIC_API_PREFIX}` }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "cp1_meetup_… access token" },
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: `${appUrl}/connect/authorize`,
              tokenUrl: `${appUrl}${PUBLIC_API_PREFIX}/oauth/token`,
              scopes: Object.fromEntries(SCOPE_DEFINITIONS.map((s) => [s.name, s.description])),
            },
          },
        },
      },
      responses: {
        Error: {
          description: "CP1 error",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["error"],
                properties: {
                  error: {
                    type: "object",
                    required: ["code", "message", "retryable", "requestId"],
                    properties: {
                      code: {
                        enum: [
                          "unauthorized", "insufficient_scope", "forbidden", "not_found",
                          "validation_failed", "conflict", "idempotency_conflict", "plan_limit",
                          "precondition_failed", "rate_limited", "upstream_failed", "unavailable", "internal",
                        ],
                      },
                      message: { type: "string" },
                      details: {
                        type: "array",
                        items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } },
                      },
                      retryable: { type: "boolean" },
                      requestId: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "x-limits": { requestsPerMinute: LIMITS.requestsPerMinute, maxBodyBytes: LIMITS.maxBodyBytes },
  };
}
