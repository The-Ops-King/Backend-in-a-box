/** D138: an upcoming booking with no run is handed to the booked-call workflows again, once; a call that has started, a cancelled one, and a baseline booking (unless asked) are not. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, many, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany, syncTriggers } from "@/engine/install";
import { emitEvent } from "@/engine/dispatch";
import { parseDefinition, extractManifest } from "@/engine/definition";
import { replayBookings } from "@/engine/replay";
import { fakeAdapters } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d138-${Date.now()}`;
let co = "";
const appt = (hoursAhead: number, status = "confirmed", withEvent = true) => asOperator(async (c) => {
  const ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,$2,'Rae') returning id", [co, `G${Math.random()}`]))!.id;
  const term = (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain='appointment_type' and category='closing' limit 1", [co]))!.id;
  const a = (await one<{ id: string }>(c, "insert into appointments (company_id, contact_id, external_id, appointment_term, starts_at, ends_at, booked_at, status) values ($1,$2,$3,$4,now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 1), now(),$6) returning id", [co, ct, `E${Math.random()}`, term, hoursAhead, status]))!.id;
  if (withEvent) await emitEvent(c, { company_id: co, contact_id: ct, opportunity_id: null, appointment_id: a, event_type: "appointment.booked", source: "ghl_poll", data: {} });
  return a;
});
const runs = (a: string) => asOperator((c) => many(c, "select 1 from runs where appointment_id=$1", [a]));

describe.skipIf(!process.env.DATABASE_URL)("D138: replaying bookings", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Replay", slug: SLUG, timezone: "America/Phoenix", locationId: "LOC-D138", pit: "pit-fake", calendars: {}, templates: [] }, fakeAdapters())).companyId;
    await asOperator(async (c) => {
      const nodes = [{ id: "t1", type: "trigger", event: "appointment.booked" }, { id: "x1", type: "exit", reason: "done" }];
      const def = parseDefinition({ schema: 1, reentry: "always", premise: { check: "none" }, nodes, edges: [{ from: "t1", to: "x1" }] });
      const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,'Booked','always',true) returning id", [co]))!;
      await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf.id, def, extractManifest(def)]);
      await syncTriggers(c, co, wf.id, def);
    });
  });

  it("dry run says what it would do and starts nothing; the real one starts the booked workflow once; again, it is refused", async () => {
    const a = await appt(24);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: true }))).toMatchObject([{ appointment_id: a, would: "replay" }]);
    expect(await runs(a)).toEqual([]);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false }))).toMatchObject([{ would: "replay", runs_started: 1 }]);
    expect((await runs(a)).length).toBe(1);
    expect(await asOperator((c) => replayBookings(c, co, [a], { dryRun: false }))).toMatchObject([{ would: "skip", why: "it already has runs" }]);
  });

  it("refused: a call that has started, a cancelled booking; a baseline booking only when asked, with an event recorded for it", async () => {
    const past = await appt(-1), cancelled = await appt(24, "cancelled"), baseline = await appt(48, "confirmed", false);
    expect((await asOperator((c) => replayBookings(c, co, [past, cancelled, baseline], { dryRun: false }))).map((r) => r.why)).toEqual(["the call has started", "cancelled", "a baseline booking (no event): replay it with baseline: true"]);
    expect(await asOperator((c) => replayBookings(c, co, [baseline], { dryRun: false, baseline: true }))).toMatchObject([{ would: "replay", runs_started: 1 }]);
    expect(await asOperator((c) => one(c, "select source, data->>'replay' as replay from events where appointment_id=$1 and event_type='appointment.booked'", [baseline]))).toEqual({ source: "engine", replay: "true" });
  });
});
