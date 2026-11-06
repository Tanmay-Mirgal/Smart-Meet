import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Lifecycle of asynchronous actions (CP1 §4: `GET /operations/{id}`).
 * pending → running → succeeded | failed. Terminal states are final.
 */

export const markRunning = internalMutation({
  args: { operationId: v.id("connector_operations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (operation?.status === "pending") {
      await ctx.db.patch(operation._id, { status: "running" });
    }
    return null;
  },
});

export const finish = internalMutation({
  args: {
    operationId: v.id("connector_operations"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    output: v.optional(v.any()),
    error: v.optional(v.object({ code: v.string(), message: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || operation.status === "succeeded" || operation.status === "failed") {
      return null;
    }
    await ctx.db.patch(operation._id, {
      status: args.status,
      output: args.output,
      error: args.error,
      finishedAt: Date.now(),
    });
    return null;
  },
});
