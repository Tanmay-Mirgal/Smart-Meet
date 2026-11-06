import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { registerConnectorRoutes } from "./connector/router";

const http = httpRouter();

// Ecosystem Connector (CP1). Every route answers 404 unless CONNECTOR_ENABLED=true.
registerConnectorRoutes(http);

type ClerkWebhookEvent = {
  type: string;
  data: {
    id: string;
    email_addresses?: Array<{ email_address: string }>;
    first_name?: string;
    last_name?: string;
    image_url?: string;
    name?: string;
    slug?: string;
    public_user_data?: { user_id: string };
    organization?: { id: string };
  };
};

http.route({
  path: "/clerk",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const payloadString = await request.text();
    const headers = request.headers;

    try {
      const svixId = headers.get("svix-id");
      const svixTimestamp = headers.get("svix-timestamp");
      const svixSignature = headers.get("svix-signature");

      if (!svixId || !svixTimestamp || !svixSignature) {
        return new Response("Missing svix headers", { status: 400 });
      }

      const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.error("Missing CLERK_WEBHOOK_SECRET");
        return new Response("Server configuration error", { status: 500 });
      }

      const wh = new Webhook(webhookSecret);
      const evt = wh.verify(payloadString, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ClerkWebhookEvent;

      const { id, ...attributes } = evt.data;

      // Handle the webhooks
      switch (evt.type) {
        case "user.created":
        case "user.updated":
          await ctx.runMutation(internal.users.index.upsertUser, {
            clerkId: id,
            email: attributes.email_addresses?.[0]?.email_address || "",
            firstName: attributes.first_name,
            lastName: attributes.last_name,
            imageUrl: attributes.image_url,
          });
          break;
        case "user.deleted":
          await ctx.runMutation(internal.users.index.deleteUser, { clerkId: id });
          break;
        case "organization.created":
        case "organization.updated":
          await ctx.runMutation(internal.users.index.upsertOrganization, {
            clerkId: id,
            name: attributes.name ?? "Organization",
            slug: attributes.slug ?? id,
            imageUrl: attributes.image_url,
          });
          break;
        case "organization.deleted":
          await ctx.runMutation(internal.users.index.deleteOrganization, {
            clerkId: id,
          });
          break;
        case "organizationMembership.created":
          if (
            !attributes.public_user_data?.user_id ||
            !attributes.organization?.id
          ) {
            break;
          }
          await ctx.runMutation(internal.users.index.addOrganizationMembership, {
            userClerkId: attributes.public_user_data.user_id,
            orgClerkId: attributes.organization.id,
          });
          break;
        case "organizationMembership.deleted":
          if (
            !attributes.public_user_data?.user_id ||
            !attributes.organization?.id
          ) {
            break;
          }
          await ctx.runMutation(internal.users.index.removeOrganizationMembership, {
            userClerkId: attributes.public_user_data.user_id,
            orgClerkId: attributes.organization.id,
          });
          break;
      }

      return new Response(null, { status: 200 });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown webhook error";
      console.error("Webhook Error:", err);
      return new Response(`Webhook Error: ${message}`, { status: 400 });
    }
  }),
});

export default http;
