/**
 * D275 (D73 everywhere): a booking stands as a call unless it was cancelled before its start. A cancel the source made after the
 * start (a host clearing a no-show's slot, or a call they held) is not a cancel: no-show beats cancelled, and showed stays showed.
 */
export const standsSql = (a: string) => `(${a}.status<>'cancelled' or ${a}.source_updated_at >= ${a}.starts_at)`;
