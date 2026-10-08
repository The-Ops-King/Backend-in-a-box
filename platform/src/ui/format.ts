import { DateTime } from "luxon";
export const ago = (d: Date | string | null | undefined) => d ? DateTime.fromJSDate(new Date(d)).toRelative() ?? "" : "";
export const when = (d: Date | string | null | undefined, tz = "America/Phoenix") => d ? DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("ccc LLL d, h:mma") : "—";
/** "10/08/26 @ 13:32" in the company's zone: the timeline's clock. */
export const stamp = (d: Date | string | null | undefined, tz = "America/Phoenix") => d ? DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("MM/dd/yy '@' HH:mm") : "—";
export const badge = (s: string | null | undefined) => `badge b-${(s ?? "").replace(/[^a-z_]/gi, "") || "type"}`;
