import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Ecosystem connector (CP1). Both are cheap no-ops when there is nothing to do.
crons.interval(
  "connector retention",
  { hours: 24 },
  internal.connector.retention.run,
  {},
);
crons.interval(
  "connector delivery sweep",
  { minutes: 2 },
  internal.connector.dispatch.sweep,
  {},
);

export default crons;
