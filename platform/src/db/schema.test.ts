import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SCHEMA } from "./schema.sql";
describe("embedded schema", () => {
  it("matches engine/schema.sql (run `pnpm schema:sync` after editing the schema)", () => {
    const p = path.resolve(process.cwd(), "..", "engine", "schema.sql");
    if (!existsSync(p)) return;   // deployed bundle has no engine/ directory; the embedded copy is the one that ships
    expect(SCHEMA).toBe(readFileSync(p, "utf8"));
  });
  it("creates every table the engine queries", () => {
    for (const t of ["companies", "users", "contacts", "contact_identifiers", "core_categories", "company_terms", "calendars", "opportunities", "appointments", "payments", "event_types", "events", "forms", "form_submissions", "intake", "workflow_templates", "workflows", "workflow_versions", "workflow_triggers", "bindings", "runs", "run_steps", "sends", "messages", "poll_cursors", "slack_connections", "audit_log"])
      expect(SCHEMA, `missing create table ${t}`).toMatch(new RegExp(`create table ${t} \\(`));
  });
});
describe("ownTables", () => {
  it("lists every schema table plus engine_state and nothing else", async () => {
    const { ownTables } = await import("./migrate");
    const t = ownTables();
    expect(t).toContain("companies"); expect(t).toContain("audit_log"); expect(t).toContain("engine_state");
    expect(t.length).toBe((SCHEMA.match(/create table /g) ?? []).length + 1);
  });
});
