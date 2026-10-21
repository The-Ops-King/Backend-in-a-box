import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/db/client";
import { chain, flow, makeStore, STORES, window } from "@/test/harness";
import { enableWorkflow, outboundShape, saveVersion, setCrmWrites, setDelivery } from "./config";
import { setupOffer } from "./testkit";

type N = Record<string, unknown>;
const trig: N = { id: "t1", type: "trigger@1", title: "Start", on: { event: "appointment.booked" } };
const text = (content = "c.m1", extra: N = {}): N => ({ id: "m1", type: "message@1", title: "Text", to: { contact: "sms" }, content, kind: "transactional", ...extra });
const tag: N = { id: "g1", type: "action@1", title: "Tag", action: "crm.add_tag", params: { tags: ["x"] } };
const end = (reason = "done"): N => ({ id: "x1", type: "end@1", title: "End", reason });
const def = (m: N = text(), e: N = end(), extra: N = {}) => flow("w", [trig, m, tag, e], chain("t1", "m1", "g1", "x1"), { sendWindow: window, ...extra });
const now = new Date("2026-10-26T14:00:00Z");

afterAll(async () => { await closeDb(); });

describe.each(STORES)("an offer's configuration, on %s", (kind) => {
  const setup = async () => {
    const store = await makeStore(kind);
    const offerId = await setupOffer(store, { slug: "acme", zone: "America/Denver", content: { "c.m1": { channel: "sms", body: "Hi" }, "c.m2": { channel: "sms", body: "Hello" } } });
    return { store, offerId, save: (d: unknown) => store.tx((tx) => saveVersion(tx, { offerId, definition: d, by: "Tyler", why: "test", now })) };
  };

  it("starts every workflow in sandbox with dry CRM writes, disabled", async () => {
    const { save } = await setup();
    const r = await save(def());
    expect(r.ok && r.workflow).toMatchObject({ delivery: "sandbox", crmWrites: "dry", enabled: false });
  });
  it("refuses a definition that does not validate, saving nothing", async () => {
    const { save, store, offerId } = await setup();
    const r = await save({ ...def(), nodes: [] });
    expect(r.ok).toBe(false);
    expect(await store.tx((tx) => tx.workflows(offerId))).toEqual([]);
  });
  it("writes every save as a new version, with who and why, and points the workflow at it", async () => {
    const { save, store } = await setup();
    await save(def());
    const r = await save(def(text(), end("finished")));
    if (!r.ok) throw new Error("did not save");
    expect(r.version).toMatchObject({ version: 2, createdBy: "Tyler", reason: "test" });
    const wf = await store.tx((tx) => tx.workflow(r.workflow.id));
    expect(wf!.currentVersionId).toBe(r.version.id);
  });
  it("going live needs the exact offer/workflow confirmation and who said so", async () => {
    const { save, store } = await setup();
    const r = await save(def());
    if (!r.ok) throw new Error("did not save");
    const set = (x: { confirm?: string; by?: string }) => store.tx((tx) => setDelivery(tx, { workflowId: r.workflow.id, delivery: "live", by: x.by ?? "Tyler", ...(x.confirm !== undefined ? { confirm: x.confirm } : {}), now }));
    expect(await set({})).toEqual({ ok: false, error: 'confirm must be exactly "acme/w"' });
    expect(await set({ confirm: "acme/other" })).toMatchObject({ ok: false });
    expect(await set({ confirm: "acme/w", by: " " })).toMatchObject({ ok: false, error: "by is required (who said to)" });
    expect(await set({ confirm: "acme/w" })).toEqual({ ok: true });
    expect(await store.tx((tx) => tx.workflow(r.workflow.id))).toMatchObject({ delivery: "live", deliverySetBy: "Tyler" });
    expect(await store.tx((tx) => setCrmWrites(tx, { workflowId: r.workflow.id, crmWrites: "real", by: "Tyler", now }))).toMatchObject({ ok: false });
  });
  it("drops a live workflow back to sandbox when a new version changes a step that reaches outside", async () => {
    const { save, store } = await setup();
    const r = await save(def());
    if (!r.ok) throw new Error("did not save");
    await store.tx((tx) => setDelivery(tx, { workflowId: r.workflow.id, delivery: "live", by: "Tyler", confirm: "acme/w", now }));
    const same = await save(def(text(), end("finished")));
    expect(same.ok && same.backToSandbox).toBe(false);
    expect((await store.tx((tx) => tx.workflow(r.workflow.id)))!.delivery).toBe("live");
    const changed = await save(def(text("c.m2")));
    expect(changed.ok && changed.backToSandbox).toBe(true);
    expect(await store.tx((tx) => tx.workflow(r.workflow.id))).toMatchObject({ delivery: "sandbox", deliverySetBy: "engine" });
  });
  it("counts the send window and the edges into an outbound step as part of it", () => {
    expect(outboundShape(def())).not.toBe(outboundShape(def(text(), end(), { sendWindow: { ...window, opens: "09:00" } })));
    const rewired = { ...def(), edges: [{ from: "t1", to: "g1" }, { from: "g1", to: "m1" }, { from: "m1", to: "x1" }] };
    expect(outboundShape(def())).not.toBe(outboundShape(rewired));
    expect(outboundShape(def())).toBe(outboundShape({ ...def(), name: "Renamed" }));
  });
  it("refuses to enable a workflow while a setting it reads has no value or content it names is missing", async () => {
    const { save, store, offerId } = await setup();
    const post: N = { id: "m1", type: "message@1", title: "Post", to: { slack: { channel: "{{setting.slack.channel.ops}}" } }, content: "c.post" };
    const r = await save(flow("w", [trig, post, end()], chain("t1", "m1", "x1")));
    if (!r.ok) throw new Error("did not save");
    expect(await store.tx((tx) => enableWorkflow(tx, r.workflow.id))).toEqual({ ok: false, missing: { settings: ["slack.channel.ops"], content: ["c.post"], workflows: [] } });
    await store.tx(async (tx) => {
      await tx.setSetting(offerId, "slack.channel.ops", "C-OPS", "Tyler");
      await tx.setContent({ offerId, key: "c.post", channel: "slack", body: "Hi team", subject: null, extras: null, approvedHash: null });
    });
    expect(await store.tx((tx) => enableWorkflow(tx, r.workflow.id))).toEqual({ ok: true });
  });
});
