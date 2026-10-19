/**
 * D154: the messages step and the company's own words. Hair's welcome on a new client is caught and cannot be approved; new
 * words are kept as the company's own and approved; changing approved words takes the approval back; a workflow the offer does
 * not use needs nothing; done once every needed message is approved. And a pre-D154 word edit moves into the company's words,
 * un-freezing its copy; one edited beyond words stays as it is.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { asOperator, one } from "@/db/client";
import { migrate } from "@/db/migrate";
import { installCompany } from "@/engine/install";
import { fakeAdapters } from "@/engine/test-install";
import { loadWords, wordsFromEdits } from "@/engine/words";
import { createClient, onboardingState } from "@/onboarding/store";
import { approveMessage, editMessage, foreignWords, listMessages } from "@/onboarding/messages";

process.env.BINDINGS_KEY ??= Buffer.alloc(32, 7).toString("base64");

describe("another client's words", () => {
  it("are found by their owner's words, and not in their owner's own company", () => {
    expect(foreignWords("glow", "Congrats on taking action to save your hair. Book with Allan.")).toEqual(['Hair\'s "save your hair"', 'Hair\'s "Allan"']);
    expect(foreignWords("glow", "Thinning hair is common.")).toEqual(['Hair\'s "Thinning"', 'Hair\'s "hair"']);
    expect(foreignWords("syh", "save your hair")).toEqual([]);
    expect(foreignWords("glow", "Hi {{contact.first_name}}, welcome to Glow.")).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("D154: the messages step", () => {
  let id: string;
  const msgs = () => asOperator((c) => listMessages(c, id));
  beforeAll(async () => {
    await migrate();
    await asOperator(async (c) => { const co = await one<{ id: string }>(c, "select id from companies where slug='words-co'"); if (!co) return;
      await c.query("delete from workflow_versions where workflow_id in (select id from workflows where company_id=$1)", [co.id]);
      for (const t of ["onboarding", "workflow_triggers", "workflows", "users", "calendars", "company_terms", "bindings", "audit_log"]) await c.query(`delete from ${t} where company_id=$1`, [co.id]);
      await c.query("delete from companies where id=$1", [co.id]); });
    id = (await asOperator((c) => createClient(c, { name: "Words Co", timezone: "America/Phoenix" })) as { id: string }).id;
    await installCompany({ name: "Words Co", slug: "words-co", timezone: "America/Phoenix", locationId: "L", pit: "p", calendars: { CAL: "closing" }, templates: ["deal-closed", "reactivation"] }, fakeAdapters());
    await asOperator((c) => c.query(`update onboarding set fit=$2 where company_id=$1`, [id, { workflows: [{ slug: "reactivation", fit: "off" }] }]));
  });

  it("Hair's welcome is caught and cannot be approved; a workflow the offer does not use needs nothing", async () => {
    const { messages, ready } = await msgs();
    const welcome = messages.find((m) => m.slug === "deal-closed" && m.channel === "sms")!;
    expect(welcome.foreign).toContain('Hair\'s "save your hair"');
    expect(await asOperator((c) => approveMessage(c, id, { workflowId: welcome.workflowId, nodeId: welcome.nodeId }))).toMatchObject({ ok: false, status: 422, why: expect.stringMatching(/another client's words/) });
    expect(ready).toBe(false);
    expect(messages.filter((m) => m.slug === "reactivation").every((m) => !m.needed)).toBe(true);
  });

  it("new words are the company's own and can be approved; changing them takes the approval back; done when all are approved", async () => {
    for (const m of (await msgs()).messages.filter((x) => x.needed))
      for (const f of m.fields) {
        const text = f.field === "subject" ? "Welcome to Words Co" : "Hi {{contact.first_name}}, welcome to Words Co. Your next steps are in your inbox.";
        expect(await asOperator((c) => editMessage(c, id, { workflowId: m.workflowId, nodeId: m.nodeId, field: f.field, text })), `${m.title} ${f.field}`).toEqual({ ok: true });
      }
    const words = await asOperator((c) => loadWords(c, id));
    expect(Object.keys(words)).toEqual(["deal-closed"]);
    for (const m of (await msgs()).messages.filter((x) => x.needed)) {
      expect(m.foreign).toEqual([]);
      expect(await asOperator((c) => approveMessage(c, id, { workflowId: m.workflowId, nodeId: m.nodeId, by: "test" }))).toEqual({ ok: true });
    }
    expect((await msgs()).ready).toBe(true);
    expect((await asOperator((c) => onboardingState(c, "words-co")))!.steps.find((s) => s.id === "messages")!.done).toMatchObject({ by: "test" });
    const sms = (await msgs()).messages.find((m) => m.slug === "deal-closed" && m.channel === "sms")!;
    await asOperator((c) => editMessage(c, id, { workflowId: sms.workflowId, nodeId: sms.nodeId, field: "template", text: "Hi {{contact.first_name}}, changed." }));
    expect((await msgs()).messages.find((m) => m.nodeId === sms.nodeId && m.slug === "deal-closed")!.approved).toBeNull();
    expect((await asOperator((c) => onboardingState(c, "words-co")))!.steps.find((s) => s.id === "messages")!.done).toBeNull();
    expect(await asOperator((c) => editMessage(c, id, { workflowId: sms.workflowId, nodeId: sms.nodeId, field: "template", text: "Hi {{nope.x}}" }))).toMatchObject({ ok: false, why: expect.stringMatching(/unknown placeholder/) });
  });

  it("a word edit made the old way moves into the company's words; a copy changed beyond words stays as it is", async () => {
    const wf = (await asOperator((c) => one<{ id: string; current_version: number; definition: { nodes: { id: string; type: string; template?: string }[] } }>(c,
      "select w.id, w.current_version, v.definition from workflows w join workflow_templates t on t.id=w.template_id join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and t.slug='reactivation'", [id])))!;
    const def = JSON.parse(JSON.stringify(wf.definition)); const sms = def.nodes.find((n: { type: string }) => n.type === "send_sms");
    sms.template = "Hi {{contact.first_name}}, the old way.";
    await asOperator(async (c) => { await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,'{\"bindings\":[]}','copy edited')", [wf.id, wf.current_version + 1, def]); await c.query("update workflows set current_version=$2, diverged=true where id=$1", [wf.id, wf.current_version + 1]); });
    const dry = await asOperator((c) => wordsFromEdits(c, id, true));
    expect(dry).toEqual({ moved: [{ workflow: expect.any(String), words: [`${sms.id}.template`] }], kept: [] });
    expect((await asOperator((c) => one<{ diverged: boolean }>(c, "select diverged from workflows where id=$1", [wf.id])))!.diverged).toBe(true);
    await asOperator((c) => wordsFromEdits(c, id, false));
    expect((await asOperator((c) => one<{ diverged: boolean }>(c, "select diverged from workflows where id=$1", [wf.id])))!.diverged).toBe(false);
    expect((await asOperator((c) => loadWords(c, id))).reactivation).toEqual({ [sms.id]: { template: "Hi {{contact.first_name}}, the old way." } });
    // the deploy's migration does the same for every company (here: nothing left to move, so nothing changes)
    expect((await migrate()).words.filter((w) => w.startsWith("words-co"))).toEqual([]);
    // a step changed by hand: not words only, so it stays
    def.nodes.find((n: { type: string }) => n.type === "send_sms").ghl_template = "snip";
    await asOperator(async (c) => { await c.query("insert into workflow_versions (workflow_id, version, definition, manifest, note) values ($1,$2,$3,'{\"bindings\":[]}','step edited')", [wf.id, wf.current_version + 2, def]); await c.query("update workflows set current_version=$2, diverged=true where id=$1", [wf.id, wf.current_version + 2]); });
    expect((await asOperator((c) => wordsFromEdits(c, id, true))).kept).toEqual([{ workflow: expect.any(String), why: expect.stringMatching(/beyond words/) }]);
  });
});
