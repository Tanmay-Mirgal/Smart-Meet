import { v } from "convex/values";

/**
 * Correlation fields shared by every entity a connector can create.
 * See CP1 §3.3 — the Hub sets these and expects them echoed back in events.
 */
export const externalRefValidator = v.object({
  hubProjectId: v.optional(v.string()),
  hubRunId: v.optional(v.string()),
  hubStepId: v.optional(v.string()),
});

export const createdViaValidator = v.literal("connector");

export type ExternalRef = {
  hubProjectId?: string;
  hubRunId?: string;
  hubStepId?: string;
};

/** Max size of caller-defined metadata once JSON-encoded (CP1 §3). */
export const MAX_METADATA_BYTES = 2048;
