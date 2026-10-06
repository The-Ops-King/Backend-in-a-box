import { DateTime } from "luxon";
export const ago = (d: Date | string | null | undefined) => d ? DateTime.fromJSDate(new Date(d)).toRelative() ?? "" : "";
export const when = (d: Date | string | null | undefined, tz = "America/Phoenix") => d ? DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("ccc LLL d, h:mma") : "—";
export const badge = (s: string | null | undefined) => `badge b-${(s ?? "").replace(/[^a-z_]/gi, "") || "type"}`;
