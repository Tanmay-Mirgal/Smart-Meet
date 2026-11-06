/**
 * Typed errors thrown by shared "core" functions.
 *
 * They extend `Error` and keep the exact messages the UI has always shown, so
 * existing callers see no difference. The connector layer uses `instanceof`
 * to map them onto CP1 error codes (plan_limit, precondition_failed, …)
 * instead of string-matching messages.
 *
 * NOTE: deliberately no `this.name = …` — it would change the "Uncaught
 * <name>: <message>" header Convex puts in dev-mode client errors.
 */

export class PlanLimitError extends Error {
  readonly details: { limit?: number | null; feature?: string };

  constructor(
    message: string,
    details: { limit?: number | null; feature?: string } = {},
  ) {
    super(message);
    this.details = details;
  }
}

export class PreconditionError extends Error {
  /** App-relative path where the user can fix the problem, e.g. /integrations. */
  readonly fixPath?: string;

  constructor(message: string, fixPath?: string) {
    super(message);
    this.fixPath = fixPath;
  }
}

export class InputError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.path = path;
  }
}
