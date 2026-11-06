/**
 * CP1 scopes for Meetup. `consent` is the plain-language sentence shown on
 * the consent screen (CP1 §2.1).
 */
export const SCOPE_DEFINITIONS = [
  {
    name: "meetup:orgs:read",
    description: "Read the connected organization's name",
    consent: "See the name of the organization you connect",
  },
  {
    name: "meetup:members:read",
    description: "Read organization members (name, email) for assignee mapping",
    consent: "See the names and emails of people in the organization",
  },
  {
    name: "meetup:meetings:read",
    description: "Read meetings, participants, settings, whiteboards and insights",
    consent: "See meetings, their participants and whiteboards",
  },
  {
    name: "meetup:meetings:write",
    description: "Create, invite to and end meetings on the user's behalf",
    consent: "Schedule, invite people to and end meetings as you",
  },
  {
    name: "meetup:transcripts:read",
    description: "Read meeting transcripts (the most sensitive meeting data)",
    consent: "Read the full text of what was said in meetings",
  },
  {
    name: "meetup:summaries:read",
    description: "Read meeting summaries, decisions and action items",
    consent: "Read AI summaries, decisions and action items",
  },
  {
    name: "meetup:recordings:read",
    description: "Read recording status and obtain short-lived playback links",
    consent: "Get short-lived links to meeting recordings",
  },
  {
    name: "meetup:tasks:read",
    description: "Read tasks",
    consent: "See tasks",
  },
  {
    name: "meetup:tasks:write",
    description: "Create and update tasks",
    consent: "Create and update tasks as you",
  },
  {
    name: "meetup:notifications:write",
    description: "Send in-app notifications to organization members",
    consent: "Send in-app notifications to people in the organization",
  },
  {
    name: "meetup:events:read",
    description: "Read the organization's connector event log (polling fallback)",
    consent: "Read the event log of this organization",
  },
  {
    name: "meetup:webhooks:manage",
    description: "Register and manage webhook endpoints for this connection",
    consent: "Receive real-time event notifications at a URL you register",
  },
] as const;

export type ScopeName = (typeof SCOPE_DEFINITIONS)[number]["name"];

export const ALL_SCOPES: readonly ScopeName[] = SCOPE_DEFINITIONS.map(
  (scope) => scope.name,
);

const SCOPE_SET = new Set<string>(ALL_SCOPES);

export function isKnownScope(value: string): value is ScopeName {
  return SCOPE_SET.has(value);
}

/** Parses a space-delimited `scope` parameter. Returns null on unknown scopes. */
export function parseScopeParam(raw: string | null | undefined): {
  scopes: ScopeName[];
  unknown: string[];
} {
  const parts = Array.from(
    new Set((raw ?? "").split(/[\s+]+/).map((s) => s.trim()).filter(Boolean)),
  );
  const unknown = parts.filter((part) => !isKnownScope(part));
  return {
    scopes: parts.filter(isKnownScope),
    unknown,
  };
}

/**
 * CP1 §5/§2.4: `meetup:webhooks:manage` is granted together with
 * `meetup:events:read` so the Hub can always heal missed webhooks by polling.
 */
export function withImpliedScopes(scopes: readonly ScopeName[]): ScopeName[] {
  const result = new Set<ScopeName>(scopes);
  if (result.has("meetup:webhooks:manage")) {
    result.add("meetup:events:read");
  }
  return Array.from(result);
}

export function scopeDescription(name: string): string {
  return (
    SCOPE_DEFINITIONS.find((scope) => scope.name === name)?.consent ?? name
  );
}
