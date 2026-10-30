/** D246/D264: who owes an end of day, at a glance, read from GHL alone: Sales Calls passed with no outcome and triage Discovery Calls still scheduled; today is said apart; someone off the team is still listed by the name GHL has. */
import { describe, it, expect, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { loadCompany } from "./context";
import { missingEods, missingLines, formatMissingEods } from "./missing-eods";
import { planCommand } from "./bot";
import { encrypt } from "./crypto";
import { liveGhlReads, type GhlReads } from "@/adapters/ghl/metrics";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const TZ = "America/New_York";
let companyId = "";
const at = (n: number, h = 11) => DateTime.now().setZone(TZ).minus({ days: n }).set({ hour: h, minute: 0, second: 0, millisecond: 0 });
const rec = (id: string, closer: string, name: string, n: number, outcome = "scheduled") => ({ id, createdAt: "", properties: { closer, outcome, contact_id: `G-${id}`, call_date: at(n).toISODate(), scheduled_at: at(n).toISO(), display_label: `${name} — ${at(n).toISODate()}` } });
const SALES = [rec("S1", "Jose P", "Tommy", 2), rec("S2", "Jose P", "Kimberly", 1), rec("S3", "Jose P", "Elizabeth", 0, ""), rec("S4", "Mel R", "Ana", 1, "showed"), rec("S5", "Carly V", "Jonelle", 3, ""), rec("S6", "Jose P", "Old", 30)];
const TRIAGE = [{ id: "D1", createdAt: "", properties: { setter: "Mitch S", outcome: "scheduled", display_label: `Pia — ${at(1).toISODate()}`, occurred_at: `${at(1).toFormat("ccc LLL d")} · 9:00 AM` } }, { id: "D2", createdAt: "", properties: { setter: "Mitch S", outcome: "showed", display_label: `Omar — ${at(1).toISODate()}`, occurred_at: "9:30 AM" } }];
const reads: GhlReads = { ...liveGhlReads, objectRecords: async (_c, object) => (object === "custom_objects.sales_call" ? SALES : TRIAGE), recordContact: async () => null };

describe.skipIf(!process.env.DATABASE_URL)("D246: missing EODs", () => {
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => {
      companyId = (await one<{ id: string }>(c, "insert into companies (name, slug, timezone) values ('D246',$1,$2) returning id", [`d246-${Date.now()}`, TZ]))!.id;
      await c.query("insert into company_terms (company_id, domain, name, category, is_default, sort) select $1, domain, label, value, true, sort from core_categories", [companyId]);
      await c.query("insert into users (company_id, email, name, role) values ($1,'jp@x.test','Jose P','closer'),($1,'mel@x.test','Mel R','closer'),($1,'mitch@x.test','Mitch S','setter')", [companyId]);
      await c.query("insert into bindings (company_id,key,kind,value) values ($1,'crm.location_id','id',convert_to('LOC','UTF8')),($1,'secret.ghl_pit','secret',$2),($1,'crm.object_sales_call','text',convert_to('custom_objects.sales_call','UTF8')),($1,'crm.object_discovery_call','text',convert_to('custom_objects.discovery_call','UTF8')),($1,'sales_call.outcomes','text',convert_to('{\"scheduled\":\"scheduled\",\"showed\":\"showed\",\"no_show\":\"noshow\",\"cancelled\":\"cancelled\",\"rescheduled\":\"rescheduled\"}','UTF8'))", [companyId, encrypt("pit")]);
    });
  });

  it("lists each person who owes a day from GHL, with the open names; today is said apart; someone off the team is listed by GHL's name; a setter's triage call too", async () => {
    const list = await asOperator(async (c) => missingEods(c, (await loadCompany(c, companyId)).row, DateTime.now(), 14, reads));
    expect(list.map((p) => [p.name, p.days.map((d) => d.names), p.today])).toEqual([["Carly V", [["Jonelle"]], []], ["Jose P", [["Tommy"], ["Kimberly"]], ["Elizabeth"]], ["Mitch S", [["Pia"]], []]]);
    expect(list[0].user_id).toBeNull();
    expect(missingLines(list)[1]).toMatch(/^Jose P is missing EOD for \w{3} \w{3} \d+ \(Tommy\), \w{3} \w{3} \d+ \(Kimberly\)$/);
    expect(formatMissingEods(list, "PMU")).toMatch(/^⚠️ \*Missing EODs · PMU\* \(4 days\)\n• Carly V is missing EOD for \w{3} \w{3} \d+ \(Jonelle\)\n• Jose P is missing EOD for .*\(Kimberly\); today so far: Elizabeth\n• Mitch S .*\(Pia\)\n_From the Sales Calls in GHL/);
    expect(formatMissingEods([], "PMU")).toMatch(/Everyone is filed/);
    // each day links through the operator's sign-in to that day's form; someone off the team has no form, so no link; the closers' private links are never in it
    const linked = formatMissingEods(list, "PMU", "https://biab.test/go/eod/pmu");
    expect(linked).toMatch(new RegExp(`<https://biab\\.test/go/eod/pmu/${list[1].user_id}/\\d{4}-\\d{2}-\\d{2}\\|\\w{3} \\w{3} \\d+> \\(Tommy\\)`));
    expect(linked).toMatch(/Carly V is missing EOD for \w{3} \w{3} \d+ \(Jonelle\)/);
    expect(linked).not.toMatch(/\/eod\/[a-z0-9]{20,}/i);
  });

  it("/missing-eod plans without a period", () => {
    expect(planCommand({ command: "/missing-eod", text: "", userId: "U", channelId: "C" }, TZ)).toEqual({ plan: { shortcut: "missing-eod", title: "Missing EODs" } });
  });
});
