import { getAction, RESOURCES, type ResourceName } from "./registry";

/**
 * Pure route table for `/connect/v1/*` (path relative to that prefix).
 * Kept free of Convex imports so it can be unit-tested.
 */
export type Route =
  | { kind: "health" }
  | { kind: "manifest" }
  | { kind: "openapi" }
  | { kind: "oauth.token" }
  | { kind: "oauth.revoke" }
  | { kind: "recording.media"; params: { id: string } }
  | { kind: "me" }
  | { kind: "action"; params: { name: string } }
  | { kind: "operation"; params: { id: string } }
  | { kind: "webhooks.create" }
  | { kind: "webhooks.list" }
  | { kind: "webhooks.get"; params: { id: string } }
  | { kind: "webhooks.update"; params: { id: string } }
  | { kind: "webhooks.delete"; params: { id: string } }
  | { kind: "webhooks.deliveries"; params: { id: string } }
  | { kind: "webhooks.redeliver"; params: { id: string; deliveryId: string } }
  | { kind: "events" }
  | { kind: "resource"; name: ResourceName; params: { id?: string } };

type Method = "GET" | "POST" | "PATCH" | "DELETE";

type Entry = {
  method: Method;
  regex: RegExp;
  build: (groups: Record<string, string>) => Route;
};

function compile(path: string): RegExp {
  return new RegExp(
    `^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}/?$`,
  );
}

const ENTRIES: Entry[] = [
  { method: "GET", regex: compile("/health"), build: () => ({ kind: "health" }) },
  { method: "GET", regex: compile("/manifest"), build: () => ({ kind: "manifest" }) },
  { method: "GET", regex: compile("/openapi.json"), build: () => ({ kind: "openapi" }) },
  { method: "POST", regex: compile("/oauth/token"), build: () => ({ kind: "oauth.token" }) },
  { method: "POST", regex: compile("/oauth/revoke"), build: () => ({ kind: "oauth.revoke" }) },
  {
    method: "GET",
    regex: compile("/recordings/{id}/media"),
    build: (g) => ({ kind: "recording.media", params: { id: g.id } }),
  },
  { method: "GET", regex: compile("/me"), build: () => ({ kind: "me" }) },
  {
    method: "POST",
    regex: compile("/actions/{name}"),
    build: (g) => ({ kind: "action", params: { name: g.name } }),
  },
  {
    method: "GET",
    regex: compile("/operations/{id}"),
    build: (g) => ({ kind: "operation", params: { id: g.id } }),
  },
  { method: "POST", regex: compile("/webhooks"), build: () => ({ kind: "webhooks.create" }) },
  { method: "GET", regex: compile("/webhooks"), build: () => ({ kind: "webhooks.list" }) },
  {
    method: "GET",
    regex: compile("/webhooks/{id}"),
    build: (g) => ({ kind: "webhooks.get", params: { id: g.id } }),
  },
  {
    method: "PATCH",
    regex: compile("/webhooks/{id}"),
    build: (g) => ({ kind: "webhooks.update", params: { id: g.id } }),
  },
  {
    method: "DELETE",
    regex: compile("/webhooks/{id}"),
    build: (g) => ({ kind: "webhooks.delete", params: { id: g.id } }),
  },
  {
    method: "GET",
    regex: compile("/webhooks/{id}/deliveries"),
    build: (g) => ({ kind: "webhooks.deliveries", params: { id: g.id } }),
  },
  {
    method: "POST",
    regex: compile("/webhooks/{id}/deliveries/{deliveryId}/redeliver"),
    build: (g) => ({
      kind: "webhooks.redeliver",
      params: { id: g.id, deliveryId: g.deliveryId },
    }),
  },
  { method: "GET", regex: compile("/events"), build: () => ({ kind: "events" }) },
  ...RESOURCES.map(
    (resource): Entry => ({
      method: resource.method,
      regex: compile(resource.path),
      build: (g) => ({
        kind: "resource",
        name: resource.name,
        params: g.id ? { id: g.id } : {},
      }),
    }),
  ),
];

export function matchRoute(method: string, path: string): Route | null {
  for (const entry of ENTRIES) {
    if (entry.method !== method) continue;
    const match = entry.regex.exec(path);
    if (match) {
      return entry.build({ ...(match.groups ?? {}) });
    }
  }
  return null;
}

/** True when the path exists for a *different* method (→ 405 rather than 404). */
export function pathExistsForOtherMethod(method: string, path: string): boolean {
  return ENTRIES.some((entry) => entry.method !== method && entry.regex.test(path));
}

/**
 * Scope(s) a bearer token must hold for a route (CP1 §4). Operations are
 * checked against the scope of the action that created them, inside the
 * exec function, so they need none here.
 */
export function requiredScopesFor(route: Route): string[] {
  switch (route.kind) {
    case "resource":
      return [...(RESOURCES.find((r) => r.name === route.name)?.scopes ?? [])];
    case "action":
      return [...(getAction(route.params.name)?.scopes ?? [])];
    case "webhooks.create":
    case "webhooks.list":
    case "webhooks.get":
    case "webhooks.update":
    case "webhooks.delete":
    case "webhooks.deliveries":
    case "webhooks.redeliver":
      return ["meetup:webhooks:manage"];
    case "events":
      return ["meetup:events:read"];
    default:
      return [];
  }
}

/** Routes served without a bearer token. */
export function isPublicRoute(route: Route): boolean {
  return (
    route.kind === "health" ||
    route.kind === "manifest" ||
    route.kind === "openapi" ||
    route.kind === "oauth.token" ||
    route.kind === "oauth.revoke" ||
    route.kind === "recording.media" // authenticated by its HMAC signature
  );
}
