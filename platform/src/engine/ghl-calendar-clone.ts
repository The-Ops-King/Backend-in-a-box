/**
 * D344 (TRC, 2026-11-17; Tyler: "can you not make it?"): a GHL calendar copied whole from one the offer already runs, with its own
 * team. Made from scratch a calendar misses what the original was set up with (the meeting location, its booking form, its
 * confirmations and reminders, its hours); copied, the new one books exactly like the old with only the named people on it.
 * The engine's own GHL token; a dry run first, always: it says what would be made and changes nothing.
 */
type Http = (method: string, path: string, opts?: { version?: "2021-07-28" | "2021-04-15"; body?: unknown }) => Promise<any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
const CAL = { version: "2021-04-15" as const };

/** What GHL owns about a calendar (its ids, its stamps, its booking link): never sent back when one is made. */
const SERVER_OWNED = new Set(["id", "_id", "slug", "widgetSlug", "dateAdded", "dateUpdated", "createdAt", "updatedAt", "deleted", "traceId", "teamMembers", "locationId", "calendarId"]);

export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

type TeamMember = Record<string, unknown> & { userId?: string; priority?: number; isPrimary?: boolean };
/**
 * The body that makes the copy: everything the original was set up with, its team replaced by `userIds` (each takes the original
 * first member's meeting settings, so a Zoom or Meet location stays the same kind), a new name and booking link.
 */
export function cloneBody(src: Record<string, unknown>, o: { name: string; userIds: string[]; locationId: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (!SERVER_OWNED.has(k) && v !== undefined) body[k] = v;
  const model: TeamMember = { ...(((src.teamMembers as TeamMember[] | undefined) ?? []).find((t) => t.isPrimary) ?? ((src.teamMembers as TeamMember[] | undefined) ?? [])[0] ?? {}) };
  delete model.userId;
  body.teamMembers = o.userIds.map((userId, i) => ({ ...model, userId, priority: 0.5, isPrimary: i === 0 }));
  body.name = o.name; body.locationId = o.locationId;
  body.slug = slugOf(o.name); body.widgetSlug = slugOf(o.name);
  return body;
}

/** GHL names a field it will not take ("property foo should not exist"); those are left out and the call made again, and said. */
const refused = (err: unknown): string[] => [...String((err as Error)?.message ?? "").matchAll(/property ([A-Za-z0-9_.]+) should not exist/g)].map((m) => m[1].split(".")[0]);

export type CloneResult = { from: { id: string; name: string }; name: string; team: string[]; would: "create" | "exists"; created?: { id: string }; left_out: string[]; copied: string[] };

export async function cloneCalendar(http: Http, locationId: string, o: { from: string; name: string; userIds: string[]; apply: boolean }): Promise<CloneResult> {
  if (!o.userIds.length) throw new Error("a calendar needs at least one team member");
  const src = ((await http("GET", `/calendars/${encodeURIComponent(o.from)}`, CAL)) as { calendar?: Record<string, unknown> }).calendar;
  if (!src) throw new Error(`GHL has no calendar ${o.from}`);
  const all = ((await http("GET", `/calendars/?locationId=${locationId}`, CAL)) as { calendars?: { id: string; name: string }[] }).calendars ?? [];
  const same = all.find((c) => c.name.trim().toLowerCase() === o.name.trim().toLowerCase());
  let body = cloneBody(src, { name: o.name, userIds: o.userIds, locationId });
  const base = { from: { id: o.from, name: String(src.name ?? o.from) }, name: o.name, team: o.userIds, left_out: [] as string[], copied: Object.keys(body).sort() };
  if (same) return { ...base, would: "exists", created: { id: same.id } };   // made already: never a second one
  if (!o.apply) return { ...base, would: "create" };
  const leftOut: string[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      const made = (await http("POST", "/calendars/", { ...CAL, body })) as { calendar?: { id?: string } };
      if (!made.calendar?.id) throw new Error("GHL made the calendar but did not say its id");
      return { ...base, would: "create", created: { id: made.calendar.id }, left_out: leftOut, copied: Object.keys(body).sort() };
    } catch (e) {
      const drop = refused(e).filter((k) => k in body && k !== "name" && k !== "teamMembers" && k !== "locationId");
      if (!drop.length || attempt >= 3) throw e;
      leftOut.push(...drop); body = Object.fromEntries(Object.entries(body).filter(([k]) => !drop.includes(k)));
    }
  }
}

/** D344: the offer's Documents & Contracts templates (what /agreement and Send agreement manually send). */
/** GHL pages them 21 at a time at most (422 "limit must not be greater than 21", 2026-11-17), as it does documents. */
export async function documentTemplates(http: Http, locationId: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for (let skip = 0; skip < 21 * 20; skip += 21) {
    const r = (await http("GET", `/proposals/templates?locationId=${locationId}&limit=21&skip=${skip}`)) as { data?: Array<{ _id?: string; id?: string; name?: string }>; templates?: Array<{ _id?: string; id?: string; name?: string }> };
    const page = (r.data ?? r.templates ?? []).map((t) => ({ id: String(t._id ?? t.id ?? ""), name: String(t.name ?? "") })).filter((t) => t.id);
    out.push(...page);
    if (page.length < 21) break;
  }
  return out;
}
