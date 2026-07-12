export interface BoundedAppendResult {
  value: string;
  truncated: boolean;
}

/** Prefix for the marker line spliced in at the truncation point. Deliberately not valid JSON (starts with "#"), so NDJSON line-parsers that skip unparseable lines (see claude-code-provider's `parseOutcome`) are unaffected by its presence. */
const TRUNCATION_MARKER_PREFIX = "# TRUNCATED:";

/**
 * Appends `chunk` to `current`, capping total size to `maxBytes` by dropping
 * bytes from the front once exceeded, and prepending a human-readable marker
 * line (itself not valid JSON, so NDJSON parsers that skip unparseable lines
 * are unaffected) recording how much was dropped.
 *
 * The most recently appended `chunk` is never touched by truncation — only
 * older content already in `current` is ever dropped — so the tail of the
 * stream is always intact, which matters for callers that only need the
 * *last* thing written (e.g. a terminating NDJSON event).
 */
export function appendBounded(current: string, chunk: string, maxBytes: number): BoundedAppendResult {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { value: combined, truncated: false };
  }

  const buf = Buffer.from(combined, "utf8");
  const excess = buf.byteLength - maxBytes;
  const kept = buf.subarray(excess).toString("utf8");

  const marker = `${TRUNCATION_MARKER_PREFIX} dropped ${excess} bytes to stay under the ${maxBytes}-byte cap\n`;
  return { value: marker + kept, truncated: true };
}
