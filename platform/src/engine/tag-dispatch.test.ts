/** D144: a tag a workflow step adds starts the workflows that start on that tag, as a tag added in GHL does; never the workflow that added it. */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one, many } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { extractManifest, indexDefinition, parseDefinition } from "@/engine/definition";
import { dispatchEvent, emitEvent } from "@/engine/dispatch";
import { tick } from "@/engine/runner";
import { fakeAdapters } from "@/engine/test-install";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const SLUG = `d144-${Date.now()}`, fake = fakeAdapters();
let co = "", ct = "";
const flow = (name: string, nodes: Record<string, unknown>[]) => asOperator(async (c) => {
  const def = { schema: 1, reentry: "always", premise: { check: "contact_exists" }, nodes: [...nodes, { id: "x1", type: "exit", reason: "done" }], edges: nodes.map((n, i) => ({ from: n.id, to: i + 1 < nodes.length ? nodes[i + 1].id : "x1" })) };
  const d = parseDefinition(def);
  const wf = (await one<{ id: string }>(c, "insert into workflows (company_id, name, reentry_policy, enabled) values ($1,$2,'always',true) returning id", [co, name]))!.id;
  await c.query("insert into workflow_versions (workflow_id, version, definition, manifest) values ($1,1,$2,$3)", [wf, def, extractManifest(d)]);
  for (const t of indexDefinition(d).triggers) await c.query("insert into workflow_triggers (company_id, workflow_id, node_id, event_type, match) values ($1,$2,$3,$4,$5)", [co, wf, t.id, t.event, t.match ?? {}]);
});
const runsOf = (name: string) => asOperator(async (c) => (await many(c, "select 1 from runs r join workflows w on w.id=r.workflow_id where r.company_id=$1 and w.name=$2", [co, name])).length);

describe.skipIf(!process.env.DATABASE_URL)("D144: tags a step adds start tag workflows", () => {
  beforeAll(async () => {
    await migrate();
    co = (await installCompany({ name: "Tags", slug: SLUG, timezone: "America/New_York", locationId: "LOC-D144", pit: "pit-fake", calendars: {}, templates: [] }, fake)).companyId;
    await asOperator(async (c) => { await c.query("update companies set mode='live' where id=$1", [co]); ct = (await one<{ id: string }>(c, "insert into contacts (company_id, ghl_contact_id, first_name) values ($1,'GC-T','Tess') returning id", [co]))!.id; });
    // Adder starts on "go" and on "reactivate" (so it would loop on its own tag), and adds "reactivate"; Reactivation starts on "reactivate"
    await flow("Adder", [{ id: "t1", type: "trigger", event: "tag.added", match: { in: ["{{event.tag}}", ["go", "reactivate"]] } }, { id: "n1", type: "tags", add: ["reactivate"] }]);
    await flow("Reactivation", [{ id: "t1", type: "trigger", event: "tag.added", match: { eq: ["{{event.tag}}", "reactivate"] } }]);
  });

  it("the tag the step added starts Reactivation once; the Adder is not started again by its own tag", async () => {
    await asOperator(async (c) => dispatchEvent(c, await emitEvent(c, { company_id: co, contact_id: ct, opportunity_id: null, appointment_id: null, event_type: "tag.added", source: "ghl_poll", data: { tag: "go" } }), { contact: { id: ct } }));
    for (let i = 0; i < 3; i++) await tick(fake, undefined, co);
    expect(await runsOf("Adder")).toBe(1);
    expect(await runsOf("Reactivation")).toBe(1);
    expect(await asOperator((c) => many(c, "select data->>'tag' as tag from events where company_id=$1 and event_type='tag.added' and source='engine'", [co]))).toEqual([{ tag: "reactivate" }]);
  });
});
