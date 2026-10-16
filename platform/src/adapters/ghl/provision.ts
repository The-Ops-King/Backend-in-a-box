import type { GhlVersion } from "./client";

/**
 * Additive GHL setup from a setup file (installs/<company>/ghl-setup.json): read the location, say what is there and what
 * is missing, and with `apply` create only what is missing. Things are matched by name (pipelines, stages, fields,
 * calendars) or key (objects, object fields, associations). Nothing is renamed, retyped or deleted. The one kind of change
 * to something that exists is additive and only on what the setup file names as its own: a stage missing from its pipeline
 * (it goes in where the setup puts it, after the stage it follows there and any stages of someone else's right after that;
 * the stages behind it move down one, D119), a field or an option missing from its object. D121: the setup's own calendars
 * also go into the setup's own calendar group (made if missing), and their team is the setup's: a calendar the setup names
 * gets the team the setup gives it, the dry run saying who leaves and who joins. Nothing outside the setup is ever written. The
 * result is shaped to merge into an install payload.
 */
export type Opt = { key: string; label: string };
export type Setup = {
  prefix: string; timezone: string; team: string[];
  hours: { days: number[]; open: string; close: string };
  pipelines: { binding: string; name: string; stages: { binding: string; name: string }[] }[];
  contactFields: { binding: string; name: string; type: string }[];
  opportunityFields: { binding: string; name: string; type: string }[];
  objects: { binding: string; key: string; label: string; plural: string; primary: { key: string; name: string }; fields: { key: string; name: string; type: string; options?: Opt[] }[] }[];
  /** first / second: "contact", "opportunity", or an object's binding; the direction is the one the templates relate in */
  associations: { binding: string; key: string; first: string; second: string }[];
  calendars: { name: string; minutes: number; term: string; callName?: string; booking?: "self" | "setter"; closerCall?: boolean; bookingCalendar?: boolean; team?: string[] }[];
  /** D121: the group the setup's calendars sit in; its name takes the prefix. Every calendar above goes in it. */
  calendarGroup?: { name: string; slug: string; description: string };
  install: Record<string, unknown>;
};
export type Http = (method: string, path: string, opts?: { version?: GhlVersion; body?: unknown }) => Promise<any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
/** `change-on-ours`: a setting of something the setup names is set to what the setup says (D121: a calendar's team). */
export type Action = "create" | "exists" | "exists-differs" | "missing-on-ours" | "change-on-ours" | "blocked";
export type Line = { action: Action; what: string; id?: string; detail?: string };

type Field = { id: string; name: string; dataType?: string; documentType?: string };
type ObjField = { id: string; name: string; fieldKey: string; dataType?: string; parentId?: string; options?: { key: string; label?: string }[] | null };
type State = {
  timezone?: string;
  pipelines: { id: string; name: string; stages: { id: string; name: string; position?: number; showInFunnel?: boolean; showInPieChart?: boolean }[] }[];
  contactFields: Field[]; opportunityFields: Field[];
  objects: { id: string; key: string; labels?: { singular?: string } }[];
  associations: { id: string; key: string; firstObjectKey: string; secondObjectKey: string }[];
  calendars: { id: string; name: string; groupId?: string | null; slotDuration?: number; slotDurationUnit?: string; slotInterval?: number; slotIntervalUnit?: string; teamMembers?: Member[]; openHours?: { daysOfTheWeek: number[]; hours: { openHour: number; openMinute: number; closeHour: number; closeMinute: number }[] }[] }[];
  groups: { id: string; name: string; slug?: string; isActive?: boolean }[];
  users: { id: string; email?: string; name?: string }[];
};
type Member = { userId: string; priority?: number; isPrimary?: boolean };

const CAL = { version: "2021-04-15" as const };
// "Dating – X" typed by hand as "dating - x" is the same thing: match on that, so a re-run never makes a near-duplicate
export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
const T = (t?: string) => { const u = (t ?? "").toUpperCase(); return u === "MONETARY" ? "MONETORY" : u; };
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return { h, m: m || 0 }; };

async function readState(call: Http, loc: string): Promise<State> {
  const [l, p, cf, of, ob, as, ca, us, gr] = await Promise.all([
    call("GET", `/locations/${loc}`), call("GET", `/opportunities/pipelines?locationId=${loc}`),
    call("GET", `/locations/${loc}/customFields?model=contact`), call("GET", `/locations/${loc}/customFields?model=opportunity`),
    call("GET", `/objects/?locationId=${loc}`), call("GET", `/associations/?locationId=${loc}&skip=0&limit=100`),
    call("GET", `/calendars/?locationId=${loc}`, CAL), call("GET", `/users/?locationId=${loc}`), call("GET", `/calendars/groups?locationId=${loc}`, CAL),
  ]);
  const fields = (r: { customFields?: Field[] }) => (r.customFields ?? []).filter((f) => f.documentType !== "folder");
  return { timezone: l.location?.timezone, pipelines: p.pipelines ?? [], contactFields: fields(cf), opportunityFields: fields(of), objects: ob.objects ?? [],
    associations: as.associations ?? [], calendars: ca.calendars ?? [], users: us.users ?? [], groups: gr.groups ?? [] };
}

/**
 * D121: what this setup owns in the location, read off the location by the setup's own names, apart from the planner: its
 * calendars (by name) and its calendar group (by name). The guard holds every calendar PUT to these.
 */
export type Own = { paths: Set<string>; calendars: Set<string>; group?: string };
export function ownedBy(setup: Setup, s: Pick<State, "calendars" | "groups">, own: Own = { paths: new Set(), calendars: new Set() }): Own {
  for (const cal of setup.calendars) { const ex = s.calendars.find((x) => norm(x.name) === norm(setup.prefix + cal.name)); if (ex) own.calendars.add(ex.id); }
  const g = setup.calendarGroup && s.groups.find((x) => norm(x.name) === norm(setup.prefix + setup.calendarGroup!.name));
  if (g) own.group = g.id;
  return own;
}
/** The only settings a calendar PUT may carry (D121): which group it is in, its team, and its schedule as it already stands
 * (GHL's PUT resets what it is not sent: a team-only PUT set the Dating calendars to 30 minutes with no hours, 2026-10-16). */
const CALENDAR_KEYS = new Set(["groupId", "teamMembers", "slotDuration", "slotDurationUnit", "slotInterval", "slotIntervalUnit", "openHours"]);

/**
 * Every write passes here. A dry run sends nothing but GETs; DELETE is never sent; a PUT goes only to an id this run matched
 * as the setup's own (its pipeline, a field of its object). D121: a calendar PUT goes only to a calendar the setup names (read
 * off the location by name, `ownedBy`, not by the planner), carries only its group and team, and the only group it may name
 * is the setup's own; a group is never PUT. The checks repeat the planner's rules so a planner bug cannot write.
 */
export function guard(http: Http, apply: boolean, own: Own, writes: string[]): Http {
  return async (method, path, opts) => {
    if (method === "DELETE") throw new Error(`provision never deletes (${path})`);
    if (method !== "GET") {
      if (!apply) throw new Error(`dry run: refused ${method} ${path}`);
      const route = path.split("?")[0];
      if (method === "PUT" && route.startsWith("/calendars/")) {
        const id = route.slice("/calendars/".length), body = (opts?.body ?? {}) as Record<string, unknown>;
        if (!own.calendars.has(id)) throw new Error(`refused PUT ${path}: not a calendar this setup names`);
        const extra = Object.keys(body).filter((k) => !CALENDAR_KEYS.has(k));
        if (extra.length) throw new Error(`refused PUT ${path}: a calendar's ${extra.join(", ")} is never changed`);
        if ("groupId" in body && (!own.group || body.groupId !== own.group)) throw new Error(`refused PUT ${path}: group ${String(body.groupId)} is not this setup's`);
      } else if (method === "PUT" && !own.paths.has(route)) throw new Error(`refused PUT ${path}: not created by this setup`);
      const gid = (opts?.body as { groupId?: unknown } | undefined)?.groupId;
      if (method === "POST" && route === "/calendars/" && gid !== undefined && gid !== own.group) throw new Error(`refused POST ${path}: group ${String(gid)} is not this setup's`);
      writes.push(`${method} ${path}`);
    }
    return http(method, path, opts);
  };
}

async function pass(setup: Setup, s: State, loc: string, call: Http, apply: boolean, own: Own) {
  const ours = own.paths;
  const plan: Line[] = [], crm: Record<string, string> = {}, calendars: Record<string, Record<string, unknown>> = {}, picks: Record<string, string> = {}, calsFound: string[] = [];
  const say = (action: Action, what: string, id?: string, detail?: string) => plan.push({ action, what, ...(id ? { id } : {}), ...(detail ? { detail } : {}) });
  const P = setup.prefix;

  if (s.timezone && norm(s.timezone) !== norm(setup.timezone)) say("exists-differs", "location timezone", undefined, `${s.timezone}; the setup's hours are meant in ${setup.timezone} and calendars keep the location's zone (not changed)`);
  else say("exists", `location timezone ${s.timezone ?? "?"}`);

  for (const p of setup.pipelines) {
    const name = P + p.name, what = `pipeline "${name}"`, ex = s.pipelines.find((x) => norm(x.name) === norm(name));
    if (!ex) {
      say("create", what, undefined, `stages: ${p.stages.map((st) => st.name).join(", ")}`);
      if (apply) await call("POST", "/opportunities/pipelines", { body: { locationId: loc, name, stages: p.stages.map((st, i) => ({ name: st.name, position: i })), showInFunnel: true, showInPieChart: true } });
      continue;
    }
    say("exists", what, ex.id); crm[`pipeline_${p.binding}`] = ex.id;
    const absent = p.stages.filter((st) => !ex.stages.some((x) => norm(x.name) === norm(st.name)));
    for (const st of p.stages) { const h = ex.stages.find((x) => norm(x.name) === norm(st.name)); if (h) { say("exists", `  stage "${st.name}"`, h.id); crm[`stage_${p.binding}_${st.binding}`] = h.id; } }
    if (!absent.length) continue;
    // D119: a missing stage goes where the setup puts it: after the stage it follows in the setup (and any stages that are not
    // the setup's right behind that one), else at the end. A stage added later (Deposit after Follow Up) lands in its place
    type Slot = { id?: string; name: string; showInFunnel?: boolean; showInPieChart?: boolean };
    const own = new Set(p.stages.map((st) => norm(st.name)));
    const list: Slot[] = ex.stages.map((x, i) => ({ x, at: x.position ?? i })).sort((a, b) => a.at - b.at).map(({ x }) => ({ id: x.id, name: x.name, ...(x.showInFunnel !== undefined ? { showInFunnel: x.showInFunnel } : {}), ...(x.showInPieChart !== undefined ? { showInPieChart: x.showInPieChart } : {}) }));
    const where: string[] = [];
    for (const st of absent) {
      const before = p.stages.slice(0, p.stages.indexOf(st)).reverse().find((b) => list.some((x) => norm(x.name) === norm(b.name)));
      let k = list.length;
      if (before) { k = list.findIndex((x) => norm(x.name) === norm(before.name)) + 1; while (k < list.length && !own.has(norm(list[k].name))) k++; }
      list.splice(k, 0, { name: st.name });
      where.push(`"${st.name}" ${before ? `after "${before.name}"` : "at the end"}`);
    }
    say("missing-on-ours", `  stages of "${name}"`, ex.id, `adds ${where.join(", ")} (none removed or renamed; the stages behind a new one move down one)`);
    if (!apply) continue;
    const path = `/opportunities/pipelines/${ex.id}`; ours.add(path);
    // GHL replaces the whole stage list on update: every stage it has goes back with its id and name, each at its place in the new order
    await call("PUT", path, { body: { name: ex.name, stages: list.map((x, i) => ({ ...x, position: i })) } });
  }

  for (const [model, list, have] of [["contact", setup.contactFields, s.contactFields], ["opportunity", setup.opportunityFields, s.opportunityFields]] as const) for (const f of list) {
    const name = P + f.name, what = `${model} field "${name}"`, ex = have.find((x) => norm(x.name) === norm(name));
    if (!ex) { say("create", what, undefined, f.type); if (apply) await call("POST", `/locations/${loc}/customFields`, { body: { name, dataType: f.type, model } }); continue; }
    if (T(ex.dataType) !== T(f.type)) { say("exists-differs", what, ex.id, `is ${ex.dataType}, the setup wants ${f.type}: left alone and not bound`); continue; }
    say("exists", what, ex.id, ex.dataType); crm[`field_${model}_${f.binding}`] = ex.id;
  }

  const objectsOk = new Set<string>();
  const objFields = async (key: string) => { const r = await call("GET", `/custom-fields/object-key/${key}?locationId=${loc}`); return { fields: (r.fields ?? []) as ObjField[], folders: (r.folders ?? []) as { id: string }[] }; };
  const addFields = async (objectKey: string, got: { fields: ObjField[]; folders: { id: string }[] }, add: Setup["objects"][number]["fields"]) => {
    const parentId = got.folders[0]?.id ?? got.fields.find((x) => x.parentId)?.parentId;
    if (!parentId) throw new Error(`${objectKey}: no field folder to add fields to`);
    for (const f of add) await call("POST", "/custom-fields/", { body: { locationId: loc, name: f.name, dataType: f.type, fieldKey: `${objectKey}.${f.key}`, objectKey, parentId, showInForms: true, ...(f.options ? { options: f.options } : {}) } });
  };
  const typeOf = (f: { type: string; options?: Opt[] }) => f.options ? `${f.type} [${f.options.map((o) => o.key).join(", ")}]` : f.type;
  for (const o of setup.objects) {
    const what = `object ${o.key}`, ex = s.objects.find((x) => x.key.toLowerCase() === o.key.toLowerCase());
    const all = [{ key: o.primary.key, name: o.primary.name, type: "TEXT" }, ...o.fields];
    if (!ex) {
      const same = s.objects.find((x) => norm(x.labels?.singular ?? "") === norm(o.label));
      if (same) { say("exists-differs", what, same.id, `an object labelled "${o.label}" already exists as ${same.key}: not created, not bound`); continue; }
      say("create", what, undefined, `"${o.label}", shown by ${o.primary.key}`); objectsOk.add(o.binding);
      for (const f of o.fields) say("create", `  field ${o.key}.${f.key}`, undefined, typeOf(f));
      if (apply) {
        await call("POST", "/objects/", { body: { locationId: loc, key: o.key, labels: { singular: o.label, plural: o.plural }, primaryDisplayPropertyDetails: { key: `${o.key}.${o.primary.key}`, name: o.primary.name, dataType: "TEXT" } } });
        const got = await objFields(o.key);
        await addFields(o.key, got, o.fields.filter((f) => !got.fields.some((x) => x.fieldKey.toLowerCase() === `${o.key}.${f.key}`.toLowerCase())));
      }
      continue;
    }
    const label = ex.labels?.singular ?? "";
    say(norm(label) === norm(o.label) ? "exists" : "exists-differs", what, ex.id, norm(label) === norm(o.label) ? undefined : `labelled "${label}", the setup says "${o.label}" (not renamed)`);
    crm[`object_${o.binding}`] = ex.key; objectsOk.add(o.binding);
    const got = await objFields(ex.key), absent: typeof o.fields = [];
    for (const f of all) {
      const fk = `${o.key}.${f.key}`, h = got.fields.find((x) => x.fieldKey.toLowerCase() === fk.toLowerCase());
      if (!h) { absent.push(f); say("missing-on-ours", `  field ${fk}`, undefined, `adds ${typeOf(f)}`); continue; }
      if (T(h.dataType) !== T(f.type)) { say("exists-differs", `  field ${fk}`, h.id, `is ${h.dataType}, the setup wants ${f.type}: left alone`); continue; }
      const lacking = ("options" in f && f.options ? f.options : []).filter((op) => !(h.options ?? []).some((x) => x.key === op.key));
      if (!lacking.length) { say("exists", `  field ${fk}`, h.id, h.dataType); continue; }
      say("missing-on-ours", `  options of ${fk}`, h.id, `adds ${lacking.map((x) => x.key).join(", ")} (keeps ${(h.options ?? []).map((x) => x.key).join(", ") || "none"})`);
      if (!apply) continue;
      const path = `/custom-fields/${h.id}`; ours.add(path);
      // the option list is replaced as a whole: every option it has goes back unchanged, so records keep their values
      await call("PUT", path, { body: { locationId: loc, name: h.name, options: [...(h.options ?? []).map((x) => ({ key: x.key, label: x.label ?? x.key })), ...lacking] } });
    }
    if (apply && absent.length) await addFields(ex.key, got, absent);
  }

  const ref = (r: string) => r === "contact" || r === "opportunity" ? { key: r, label: r === "contact" ? "Contact" : "Opportunity", ok: true } : (() => {
    const o = setup.objects.find((x) => x.binding === r); if (!o) throw new Error(`association refers to unknown object "${r}"`);
    return { key: o.key, label: o.label, ok: objectsOk.has(r) };
  })();
  for (const a of setup.associations) {
    const f = ref(a.first), sc = ref(a.second), what = `association ${a.key} (${f.key} → ${sc.key})`;
    const ex = s.associations.find((x) => x.key.toLowerCase() === a.key.toLowerCase());
    if (ex) {
      if (ex.firstObjectKey === f.key && ex.secondObjectKey === sc.key) { say("exists", what, ex.id); crm[`assoc_${a.binding}`] = ex.id; }
      else say("exists-differs", what, ex.id, `links ${ex.firstObjectKey} → ${ex.secondObjectKey}: not bound`);
      continue;
    }
    const pair = s.associations.find((x) => x.firstObjectKey === f.key && x.secondObjectKey === sc.key);
    if (pair) { say("exists-differs", what, pair.id, `${pair.key} already links them: not created, not bound`); continue; }
    if (!f.ok || !sc.ok) { say("blocked", what, undefined, "its object is not there and will not be made"); continue; }
    say("create", what);
    if (apply) await call("POST", "/associations/", { body: { locationId: loc, key: a.key, firstObjectLabel: f.label, firstObjectKey: f.key, secondObjectLabel: sc.label, secondObjectKey: sc.key } });
  }

  const o = hm(setup.hours.open), c = hm(setup.hours.close);
  // GHL takes one entry per weekday ("openHours.0.must be a valid day of week" for a list of days, 2026-10-16)
  const openHours = setup.hours.days.map((d) => ({ daysOfTheWeek: [d], hours: [{ openHour: o.h, openMinute: o.m, closeHour: c.h, closeMinute: c.m }] }));
  const hoursKey = (h: State["calendars"][number]["openHours"]) => JSON.stringify((Array.isArray(h) ? h : []).flatMap((x) => x.daysOfTheWeek.map((d) => [d, x.hours.map((y) => [y.openHour, y.openMinute, y.closeHour, y.closeMinute])])).sort());
  // D121: the setup's calendar group, made if missing; the setup's calendars go in it (never one that is in someone else's)
  const G = setup.calendarGroup, gname = G ? P + G.name : "";
  let groupId: string | undefined, group: "found" | "planned" | "blocked" | undefined;
  if (G) {
    const what = `calendar group "${gname}"`, ex = s.groups.find((x) => norm(x.name) === norm(gname));
    if (ex) { say("exists", what, ex.id, ex.isActive === false ? "disabled in GHL (left so)" : undefined); groupId = ex.id; group = "found"; }
    else {
      const taken = s.groups.find((x) => (x.slug ?? "").toLowerCase() === G.slug.toLowerCase());
      if (taken) { say("blocked", what, undefined, `its slug "${G.slug}" is the group "${taken.name}"'s: not made (give the setup another slug)`); group = "blocked"; }
      else {
        say("create", what, undefined, `slug ${G.slug}; the setup's ${setup.calendars.length} calendars go in it`); group = "planned";
        if (apply) {
          await call("POST", "/calendars/groups", { ...CAL, body: { locationId: loc, name: gname, description: G.description, slug: G.slug, isActive: true } });
          // its id from a fresh read by its name, the way the guard knows it, not from the answer
          ownedBy(setup, { calendars: [], groups: (await call("GET", `/calendars/groups?locationId=${loc}`, CAL)).groups ?? [] }, own);
          if (!own.group) throw new Error(`${what} was made but the location's groups do not list it`);
          groupId = own.group; group = "found";
        }
      }
    }
  }

  const who = (id: string) => { const u = s.users.find((x) => x.id === id); return u ? `${u.name ?? "?"} <${u.email ?? "?"}>` : id; };
  for (const cal of setup.calendars) {
    const name = P + cal.name, what = `calendar "${name}"`, ex = s.calendars.find((x) => norm(x.name) === norm(name));
    const emails = cal.team ?? setup.team, users = emails.map((e) => ({ e, u: s.users.find((x) => (x.email ?? "").toLowerCase() === e.toLowerCase()) }));
    const lost = users.filter((x) => !x.u).map((x) => x.e), want = users.filter((x) => x.u).map((x) => x.u!.id);
    const mapping = { term: cal.term, ...(cal.callName ? { name: cal.callName } : {}), ...(cal.booking ? { booking: cal.booking } : {}) };
    if (ex) {
      const diffs: string[] = [];
      if (ex.slotDuration !== cal.minutes || (ex.slotDurationUnit ?? "mins") !== "mins") diffs.push(`${ex.slotDuration} ${ex.slotDurationUnit ?? ""} long, the setup says ${cal.minutes} mins`);
      if (hoursKey(ex.openHours) !== hoursKey(openHours)) diffs.push("open hours differ");
      say(diffs.length ? "exists-differs" : "exists", what, ex.id, diffs.length ? `${diffs.join("; ")} (not changed)` : undefined);
      calendars[ex.id] = mapping; calsFound.push(cal.name); if (cal.closerCall) picks.closerCall = ex.id; if (cal.bookingCalendar) picks.bookingCalendar = ex.id;
      // D121: the calendar is the setup's, so its team is the one the setup gives: who leaves and who joins, said exactly
      const put: Record<string, unknown> = {}, has = (ex.teamMembers ?? []).map((t) => t.userId);
      if (lost.length) say("exists-differs", `  team of ${what}`, ex.id, `no user in the location with email ${lost.join(", ")}: team not changed`);
      else if (has.length === want.length && want.every((id) => has.includes(id))) say("exists", `  team of ${what}`, ex.id, want.map(who).join(", "));
      else {
        const leaves = has.filter((id) => !want.includes(id)), joins = want.filter((id) => !has.includes(id));
        const stays = has.some((id) => want.includes(id)) ? ` (${[joins.length ? `joins: ${joins.map(who).join(", ")}` : "", leaves.length ? `leaves: ${leaves.map(who).join(", ")}` : ""].filter(Boolean).join("; ")})` : "";
        say("change-on-ours", `  team of ${what}`, ex.id, `${has.map(who).join(", ") || "nobody"} → ${want.map(who).join(", ")}${stays}; calls already booked are not reassigned by this`);
        // GHL replaces the team as a whole: one who stays keeps their priority and whether they are primary
        const primary = want.find((id) => ex.teamMembers?.find((t) => t.userId === id)?.isPrimary) ?? want[0];
        put.teamMembers = want.map((id) => ({ userId: id, priority: ex.teamMembers?.find((t) => t.userId === id)?.priority ?? 0.5, isPrimary: id === primary }));
      }
      if (G) {
        const cur = ex.groupId || undefined;
        if (cur && cur === groupId) say("exists", `  group of ${what}`, ex.id, `in "${gname}"`);
        else if (cur) say("exists-differs", `  group of ${what}`, ex.id, `in the group "${s.groups.find((g) => g.id === cur)?.name ?? cur}", not the setup's: not moved`);
        else if (group === "blocked") say("blocked", `  group of ${what}`, ex.id, `"${gname}" is not there and will not be made`);
        else { say("missing-on-ours", `  group of ${what}`, ex.id, `goes in "${gname}"${group === "planned" && !groupId ? " (made above)" : ""}`); if (groupId) put.groupId = groupId; }
      }
      // GHL's PUT resets every scheduling setting it is not sent, so the calendar's own schedule goes back with it, unchanged
      const keep = { slotDuration: ex.slotDuration, slotDurationUnit: ex.slotDurationUnit ?? "mins", slotInterval: ex.slotInterval ?? ex.slotDuration, slotIntervalUnit: ex.slotIntervalUnit ?? ex.slotDurationUnit ?? "mins", openHours: Array.isArray(ex.openHours) ? ex.openHours : [] };
      if (apply && Object.keys(put).length) await call("PUT", `/calendars/${ex.id}`, { ...CAL, body: { ...put, ...keep } });
      continue;
    }
    if (lost.length) { say("blocked", what, undefined, `no user in the location with email ${lost.join(", ")}`); continue; }
    const into = G && group !== "blocked" ? `, in group "${gname}"` : "";
    say("create", what, undefined, `${cal.minutes} min, ${setup.hours.days.join(",")} ${setup.hours.open}-${setup.hours.close}, team ${users.map((x) => `${x.e} (${x.u!.id})`).join(", ")}${into}`);
    if (apply) await call("POST", "/calendars/", { ...CAL, body: { locationId: loc, name, calendarType: "round_robin", eventType: "RoundRobin_OptimizeForAvailability",
      teamMembers: users.map((x, i) => ({ userId: x.u!.id, priority: 0.5, isPrimary: i === 0 })), slotDuration: cal.minutes, slotDurationUnit: "mins", slotInterval: cal.minutes, slotIntervalUnit: "mins", openHours, isActive: true,
      ...(G && groupId ? { groupId } : {}) } });
  }
  return { plan, crm, calendars, picks, calsFound, groupFound: group === "found" };
}

/** Every key the setup should produce in the install's crm map, to say which ones a dry run (or a refused item) leaves empty. */
const wanted = (s: Setup) => [
  ...s.pipelines.flatMap((p) => [`pipeline_${p.binding}`, ...p.stages.map((st) => `stage_${p.binding}_${st.binding}`)]),
  ...s.contactFields.map((f) => `field_contact_${f.binding}`), ...s.opportunityFields.map((f) => `field_opportunity_${f.binding}`),
  ...s.objects.map((o) => `object_${o.binding}`), ...s.associations.map((a) => `assoc_${a.binding}`),
];

const noneOwned = (): Own => ({ paths: new Set(), calendars: new Set() });

export async function provision(setup: Setup, locationId: string, http: Http, opts: { apply: boolean }) {
  const own = noneOwned(), writes: string[] = [];
  const call = guard(http, opts.apply, own, writes);
  const start = await readState(call, locationId);
  ownedBy(setup, start, own);
  const first = await pass(setup, start, locationId, call, opts.apply, own);
  // after writes, the ids come from a fresh read (what GHL now holds), and that read must find nothing left to do
  const final = opts.apply && writes.length ? await (async () => {
    const again = noneOwned(), dry = guard(http, false, again, []), s = await readState(dry, locationId);
    return pass(setup, s, locationId, dry, false, ownedBy(setup, s, again));
  })() : first;
  const { crm, calendars, picks, calsFound } = final;
  const missing = [...wanted(setup).filter((k) => !crm[k]), ...setup.calendars.filter((c) => !calsFound.includes(c.name)).map((c) => `calendar "${setup.prefix + c.name}"`),
    ...(setup.calendarGroup && !final.groupFound ? [`calendar group "${setup.prefix + setup.calendarGroup.name}"`] : [])];
  const inst = setup.install as { salesCall?: Record<string, unknown> };
  // D118: the Sales Call's objection options are the ones its setup gives the field, so the templates write only those
  const objections = setup.objects.find((o) => o.binding === "sales_call")?.fields.find((f) => f.key === "objection_primary")?.options?.map((o) => o.key) ?? [];
  const install: Record<string, unknown> = {
    ...setup.install, timezone: setup.timezone, locationId,
    calendars, ...(picks.closerCall ? { closerCall: picks.closerCall } : {}), ...(picks.bookingCalendar ? { bookingCalendar: picks.bookingCalendar } : {}),
    crm, salesCall: { ...(objections.length ? { objections } : {}), ...(inst.salesCall ?? {}), ...(crm.object_sales_call ? { object: crm.object_sales_call } : {}) },
    ...(missing.length ? { _missing: missing } : {}),
  };
  return { plan: first.plan, after: opts.apply && writes.length ? final.plan : undefined, install, writes };
}

export function summary(plan: Line[]): string {
  const n = (a: Action) => plan.filter((l) => l.action === a).length;
  return (["create", "exists", "exists-differs", "missing-on-ours", "change-on-ours", "blocked"] as const).map((a) => `${a} ${n(a)}`).join(" · ");
}
export function printable(plan: Line[]): string {
  return plan.map((l) => `${l.action.padEnd(16)} ${l.what}${l.id ? `  [${l.id}]` : ""}${l.detail ? `  — ${l.detail}` : ""}`).join("\n");
}
