/** D193: the settings an offer runs on are its own: one list of defaults, written onto every offer, read one way. */
import { describe, it, expect } from "vitest";
import { asOperator, db } from "@/db/client";
import { migrate } from "@/db/migrate";
import { MIGRATIONS } from "@/db/migrations";
import type { Migrator } from "@/db/migrator";
import { SETTING_DEFAULTS, isDefaultValue, switchOn, writeDefaults } from "./setting-defaults";
import { salesCallConfig } from "./ghl-metrics";
import { objectionOptions, DEFAULT_OBJECTIONS } from "./sales-call";
import { callSetting } from "./call-settings";

describe("one reading of a yes/no setting", () => {
  it("on and off in any of the words used; unset or anything else is the setting's own default", () => {
    for (const v of ["on", "ON", "yes", "true", "1", " on "]) expect(switchOn({ "slack.live": v }, "slack.live"), v).toBe(true);
    for (const v of ["off", "no", "false", "0"]) expect(switchOn({ "crm.tasks": v }, "crm.tasks"), v).toBe(false);
    expect(switchOn({}, "crm.tasks")).toBe(true);
    expect(switchOn({ "crm.tasks": "maybe" }, "crm.tasks")).toBe(true);
    expect(switchOn({}, "slack.live")).toBe(false);
    expect(switchOn({ "slack.live": "" }, "slack.live")).toBe(false);
  });

  it("each listed default is what its reader falls back on, so writing it changes nothing", () => {
    for (const [k, d] of Object.entries(SETTING_DEFAULTS)) {
      if (d.kind === "switch") expect(switchOn({ [k]: d.default }, k as never), k).toBe(switchOn({}, k as never));
      if (k.startsWith("calls.") || k.startsWith("setter_result.set")) expect(callSetting({ [k]: d.default }, k as never), k).toBe(callSetting({}, k as never));
    }
  });

  it("a value at its default is not one the offer chose; another value is", () => {
    expect(isDefaultValue("crm.tasks", "on")).toBe(true);
    expect(isDefaultValue("crm.tasks", "off")).toBe(false);
    expect(isDefaultValue("prompt.x", "on")).toBe(false);
  });

  it("settings whose readers disagree on 'unset' are left unset (Tyler decides)", () => {
    for (const k of ["crm.object_discovery_call", "sales_call.dispositions", "sales_call.objections"]) expect(k in SETTING_DEFAULTS, k).toBe(false);
    expect(objectionOptions({})).toEqual(DEFAULT_OBJECTIONS);
  });

  it("an offer without its own dispositions counts a pending close as pending (the copy had lost close_pending)", () => {
    expect(salesCallConfig({ "crm.object_sales_call": "custom_objects.sales_call" })!.dispositions.close_pending).toEqual({ meaning: "pending" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D193: the defaults written onto each offer", () => {
  const keys = async (co: string) => Object.fromEntries((await asOperator((c) => c.query<{ key: string; v: string }>("select key, convert_from(value,'UTF8') as v from bindings where company_id=$1", [co]))).rows.map((r) => [r.key, r.v]));

  it("writes only what the offer lacks, as the default; its own values stay; a second run writes nothing", async () => {
    await migrate();
    const co = (await db().query("insert into companies (name, slug, timezone) values ('Defaults', $1, 'UTC') returning id", [`defaults-${Date.now()}`])).rows[0].id as string;
    await asOperator((c) => c.query("insert into bindings (company_id, key, kind, value) values ($1,'crm.tasks','text',convert_to('off','UTF8')),($1,'alerts.repeat_minutes','number',convert_to('30','UTF8'))", [co]));
    const wrote = await asOperator((c) => writeDefaults(c, co));
    expect(wrote).not.toContain("crm.tasks");
    expect(wrote.length).toBe(Object.keys(SETTING_DEFAULTS).length - 2);
    const b = await keys(co);
    expect(b["crm.tasks"]).toBe("off");
    expect(b["alerts.repeat_minutes"]).toBe("30");
    expect(b["slack.live"]).toBe("off");
    expect(b["calls.transcript_wait_min"]).toBe("120");
    expect(await asOperator((c) => writeDefaults(c, co))).toEqual([]);
  });

  it("migration 0004 gives every offer its own copy, and its own values stay", async () => {
    // run inside a transaction rolled back after, so the test database's other companies are left as they were
    const conn = await db().connect();
    try {
      await conn.query("begin");
      const t: Migrator = { query: (sql, params) => conn.query(sql, params), tx: (fn) => fn(t) };
      const co = (await conn.query("insert into companies (name, slug, timezone) values ('Old offer', $1, 'UTC') returning id", [`old-offer-${Date.now()}`])).rows[0].id as string;
      await conn.query("insert into bindings (company_id, key, kind, value) values ($1,'slack.live','text',convert_to('yes','UTF8'))", [co]);
      await MIGRATIONS.find((m) => m.id === "0004-settings-onto-offers")!.run(t);
      const b = Object.fromEntries((await conn.query<{ key: string; v: string }>("select key, convert_from(value,'UTF8') as v from bindings where company_id=$1", [co])).rows.map((r) => [r.key, r.v]));
      for (const [k, d] of Object.entries(SETTING_DEFAULTS)) expect(b[k], k).toBe(k === "slack.live" ? "yes" : d.default);
      expect((await conn.query("select after->>'by' as by from audit_log where company_id=$1", [co])).rows).toEqual([{ by: "migration 0004" }]);
    } finally { await conn.query("rollback"); conn.release(); }
  });
});
