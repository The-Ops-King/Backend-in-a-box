/** D234: the minute poll reads in full only the bookings the source changed since its last pass, and every booking once an hour. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { encrypt } from "@/engine/crypto";
import { pollCompany, FULL_BOOKING_READ_MS } from "@/engine/poll";
import { fakeAdapters } from "@/engine/test-install";
import type { Adapters, BookingRead } from "@/adapters/types";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
let companyId = "";
const stamps: Record<string, string> = { E1: "2026-10-24T10:00:00Z", E2: "2026-10-24T10:00:00Z" };
const asked: Array<string[]> = [];
const read: BookingRead = {
  // as the Calendly reader does: every event's stamp into `seen`, the unchanged ones skipped
  appointmentsInWindow: async (_c, _cal, _f, _t, delta) => {
    const out: string[] = [];
    for (const [id, at] of Object.entries(stamps)) { if (delta) delta.seen[id] = at; if (delta?.known?.[id] === at) continue; out.push(id); }
    asked.push(out);
    return [];
  },
  getAppointment: async () => null, listCalendars: async () => [],
};
const base = fakeAdapters();
const fake: Adapters = { ...base, booking: { ghl: read, calendly: read } };

describe.skipIf(!process.env.DATABASE_URL)("D234: only changed bookings are read each minute", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D234',$1,'UTC') returning id", [`d234-${Date.now()}`]))!.id;
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',$2),($1,'secret.ghl_pit','secret',$3)", [companyId, Buffer.from("L"), encrypt("p")]);
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into calendars (company_id, source, external_id, name, appointment_term) select $1, 'ghl', 'CAL1', 'Closer', id from company_terms where company_id=$1 and domain='appointment_type' and category='closing'", [companyId]);
    });
  });

  it("first pass reads all; the next reads only what changed; after an hour all again", async () => {
    await pollCompany(fake, companyId);
    await pollCompany(fake, companyId);
    stamps.E2 = "2026-10-24T11:00:00Z";
    await pollCompany(fake, companyId);
    expect(asked).toEqual([["E1", "E2"], [], ["E2"]]);
    await asOperator((c) => c.query("update engine_state set value = jsonb_set(value, '{full_at}', to_jsonb($2::text)) where key=$1", [`booking_seen:${companyId}:CAL1`, new Date(Date.now() - FULL_BOOKING_READ_MS - 1000).toISOString()]));
    await pollCompany(fake, companyId);
    expect(asked.at(-1)).toEqual(["E1", "E2"]);
  });
});
