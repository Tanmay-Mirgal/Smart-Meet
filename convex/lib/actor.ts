import type { UserIdentity } from "convex/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getCurrentUserRecord } from "./auth";

/**
 * Who is performing an operation.
 *
 * Every public Convex function authenticates with a Clerk JWT
 * (`ctx.auth.getUserIdentity()`). The shared "core" helpers behind those
 * functions take an `Actor` instead, so the exact same business rules can be
 * driven by the browser (identity → actor) or by the ecosystem connector
 * (stored grant → actor) without duplicating any logic.
 */
export type Actor = {
  /** Convex tokenIdentifier — the key used by every membership / participant lookup. */
  tokenIdentifier: string;
  /** Clerk user id (JWT `subject`). */
  clerkId: string;
  /** `identity.name`, if the identity provider supplied one. */
  name: string | null;
  email: string | null;
  imageUrl?: string;
  /** `name ?? email ?? "Meetup User"` — what the UI shows for this person. */
  displayName: string;
};

export function actorFromIdentity(identity: UserIdentity): Actor {
  return {
    tokenIdentifier: identity.tokenIdentifier,
    clerkId: identity.subject,
    name: identity.name ?? null,
    email: identity.email ?? null,
    imageUrl: identity.pictureUrl,
    displayName: identity.name ?? identity.email ?? "Meetup User",
  };
}

/**
 * Builds the actor for a stored user, e.g. the user who consented to a
 * connector grant. Returns null if the user no longer exists.
 */
export async function actorFromTokenIdentifier(
  ctx: QueryCtx | MutationCtx,
  tokenIdentifier: string,
): Promise<Actor | null> {
  const user = await getCurrentUserRecord(ctx, tokenIdentifier);
  if (!user) {
    return null;
  }

  const name =
    user.fullName?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    null;
  const email = user.email?.trim() || null;

  return {
    tokenIdentifier,
    clerkId: user.clerkId,
    name,
    email,
    imageUrl: user.imageUrl || undefined,
    displayName: name ?? email ?? "Meetup User",
  };
}
