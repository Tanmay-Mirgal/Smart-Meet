import { bytesToBase64Url, base64UrlToBytes } from "./crypto";
import { ConnectorError } from "./errors";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Hard bound on documents examined for one page, however selective the filter. */
const SCAN_CAP = 600;

/**
 * Cursors are opaque to callers: base64url(JSON). They are KEYSET cursors (a
 * position in a stable order), not offsets, so concurrent inserts can never
 * make a page skip or repeat an item (CP1 §3, C12).
 */
export function encodeCursor(value: Record<string, string | number>): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursor<T>(
  cursor: string | undefined,
  guard: (value: unknown) => value is T,
): T | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(cursor)));
    if (guard(value)) return value;
  } catch {
    // fall through
  }
  throw new ConnectorError("validation_failed", "Invalid cursor", {
    details: [{ path: "cursor", message: "Invalid or expired cursor" }],
  });
}

export const isTimeCursor = (value: unknown): value is { t: number } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { t?: unknown }).t === "number" &&
  Number.isFinite((value as { t: number }).t);

export const MAX_TIME = Number.MAX_SAFE_INTEGER;

/**
 * Newest-first page over an index ordered by `_creationTime`. `fetchBatch`
 * returns up to `n` documents strictly older than `upper`; `accept` filters
 * in memory (for fields that have no index) while `SCAN_CAP` keeps the work
 * bounded. Returns the cursor time to continue from, or null when finished.
 */
export async function scanNewestFirst<T extends { _creationTime: number }>(options: {
  limit: number;
  beforeTime?: number;
  fetchBatch: (upper: number, n: number) => Promise<T[]>;
  accept?: (item: T) => boolean | Promise<boolean>;
}): Promise<{ items: T[]; nextTime: number | null }> {
  const { limit, accept, fetchBatch } = options;
  // With no filter one batch of limit+1 both fills the page and peeks for more.
  const batchSize = accept ? 100 : limit + 1;

  const items: T[] = [];
  let upper = options.beforeTime ?? MAX_TIME;
  let scanned = 0;
  let lastScannedTime: number | null = null;
  let lastReturnedTime: number | null = null;
  let hasMore = false;
  let exhausted = false;

  scan: while (scanned < SCAN_CAP) {
    const batch = await fetchBatch(upper, batchSize);
    for (const doc of batch) {
      scanned += 1;
      lastScannedTime = doc._creationTime;
      if (!accept || (await accept(doc))) {
        if (items.length === limit) {
          hasMore = true; // an item beyond the page exists
          break scan;
        }
        items.push(doc);
        lastReturnedTime = doc._creationTime;
      }
    }
    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
    upper = batch[batch.length - 1]._creationTime;
  }

  if (!hasMore && !exhausted) hasMore = true; // stopped by the scan cap

  const nextTime = hasMore
    ? items.length === limit
      ? lastReturnedTime
      : lastScannedTime
    : null;
  return { items, nextTime };
}
