import { describe, expect, it } from "vitest";
import type { AiPort, CallContext, CrmPort, EsignPort, MessagingPort, SchedulingPort } from "@/engine/ports";
import { type Kit, factsOf } from "../testkit/kit";
import type { J } from "../framework/types";

/**
 * The contract every provider of a port must pass, the same suite for each (the blueprint's adapter contract tests).
 * A fixture gives the provider's port on the fake HTTP layer, and the few things only the vendor's own state can answer
 * (`inspect`): what the fake vendor now holds. Shapes a fixture uses that the Phase 0 checks or a real sandbox have
 * not confirmed say so in their name (`unverified`).
 */

const ctx = (k: Kit, key: string): CallContext => ({ offerId: k.offerId, idempotencyKey: key });

// ---- crm ----------------------------------------------------------------------------------------------------------------

export type CrmFixture = {
  k: Kit; port: CrmPort;
  /** A contact the vendor holds already. */
  seed(x: { email?: string; phone?: string; tags?: string[] }): Promise<string>;
  inspect: { contacts(): number; tags(id: string): string[]; field(id: string, canonical: string): unknown; dnd(id: string): boolean; deals(contactId: string): { id: string; stage: string; status: string; value?: number }[]; tasks(contactId: string): number; notes(contactId: string): number; records(object: string): { id: string; properties: J }[] };
  /** Makes the vendor refuse the connection's token from now on. */
  revoke(): void;
  /** Canonical fields the fixture's field map knows, with a value of each one's type. */
  fields: Record<string, unknown>;
  object: string;
};

export function crmContract(name: string, make: () => Promise<CrmFixture>) {
  describe(`crm contract: ${name}`, () => {
    it("reads a contact (addresses and DND), and none for an id the CRM does not have", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com", phone: "+15550100001" });
      expect(await f.port.getContact(ctx(f.k, "r"), id)).toMatchObject({ id, email: "ana@example.com", phone: "+15550100001", dnd: expect.any(Object) });
      expect(await f.port.getContact(ctx(f.k, "r2"), "nope-not-there")).toBeNull();
    });

    it("find-or-create is idempotent: the same person twice is one contact", async () => {
      const f = await make();
      const p = { match: ["email", "phone"], create: true, fillBlank: { email: "new@example.com", phone: "+15550100002", first_name: "New" } };
      const a = await f.port.findOrCreateContact(ctx(f.k, "a"), null, p);
      const b = await f.port.findOrCreateContact(ctx(f.k, "b"), null, p);
      expect(a.action).toBe("created");
      expect(b).toEqual({ id: a.id, action: "found" });
      expect(f.inspect.contacts()).toBe(1);
      const existing = await f.seed({ email: "old@example.com" });
      expect(await f.port.findOrCreateContact(ctx(f.k, "c"), existing, { match: ["crm_id"], create: false })).toEqual({ id: existing, action: "found" });
    });

    it("writes canonical fields through the field map and they read back the same (a date as its day)", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com" });
      await f.port.updateContact(ctx(f.k, "u"), id, { set: f.fields });
      for (const [k, v] of Object.entries(f.fields)) expect(f.inspect.field(id, k)).toEqual(typeof v === "string" && /T\d\d:/.test(v) ? v.slice(0, 10) : v);
      await expect(f.port.updateContact(ctx(f.k, "u2"), id, { set: { not_in_the_map: "x" } })).rejects.toMatchObject({ failure: "permanent" });
    });

    it("tags are added and removed without touching the others, and doing it twice changes nothing more", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com", tags: ["keep"] });
      await f.port.addTags(ctx(f.k, "t1"), id, ["a", "b"]);
      await f.port.addTags(ctx(f.k, "t2"), id, ["a"]);
      await f.port.removeTags(ctx(f.k, "t3"), id, ["b"]);
      await f.port.removeTags(ctx(f.k, "t4"), id, ["b"]);
      expect(f.inspect.tags(id).sort()).toEqual(["a", "keep"]);
    });

    it("marks DND, and the gate's read of the contact then says so", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com" });
      await f.port.markDnd(ctx(f.k, "d"), id, "all");
      expect(f.inspect.dnd(id)).toBe(true);
      expect((await f.port.getContact(ctx(f.k, "d2"), id))!.dnd.all).toBe(true);
    });

    it("moves the contact's one open deal on a pipeline, making it once; sets its status and value", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com" });
      const a = await f.port.moveDeal(ctx(f.k, "m1"), id, { pipeline: "P1", stage: "S1", ifMissing: "create", pick: "open", name: "Ana" });
      const b = await f.port.moveDeal(ctx(f.k, "m2"), id, { pipeline: "P1", stage: "S2", ifMissing: "create", pick: "open" });
      expect(b).toEqual(a);
      expect(f.inspect.deals(id)).toEqual([expect.objectContaining({ id: a!.id, stage: "S2", status: "open" })]);
      expect(await f.port.moveDeal(ctx(f.k, "m3"), await f.seed({ email: "b@x.com" }), { pipeline: "P1", stage: "S1", ifMissing: "skip", pick: "open" })).toBeNull();
      await f.port.updateDeal(ctx(f.k, "m4"), id, { pipeline: "P1", value: "2999" });
      await f.port.setDealStatus(ctx(f.k, "m5"), id, { pipeline: "P1", status: "won" });
      await f.port.setDealStatus(ctx(f.k, "m6"), id, { pipeline: "P1", status: "lost", from: ["open"] });
      expect(f.inspect.deals(id)[0]).toMatchObject({ status: "won", value: 2999 });
    });

    it("opens a task and adds a note on the contact", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com" });
      expect((await f.port.createTask(ctx(f.k, "k1"), id, { title: "Call Ana", due: "1d" })).id).toBeTruthy();
      await f.port.addNote(ctx(f.k, "k2"), id, "She asked about financing");
      expect([f.inspect.tasks(id), f.inspect.notes(id)]).toEqual([1, 1]);
    });

    it("upserts a custom object record by the platform's key (one record however often), and relates it once", async () => {
      const f = await make();
      const a = await f.port.upsertRecord(ctx(f.k, "r1"), { object: f.object, key: "call-1", properties: { outcome: "showed" }, ifMissing: "create" });
      const b = await f.port.upsertRecord(ctx(f.k, "r2"), { object: f.object, key: "call-1", properties: { outcome: "noshow" }, ifMissing: "create" });
      expect(b.id).toBe(a.id);
      expect(f.inspect.records(f.object)).toEqual([expect.objectContaining({ id: a.id, properties: expect.objectContaining({ outcome: "noshow" }) })]);
      await f.port.relateRecords(ctx(f.k, "r3"), { association: "AS1", first: a.id, second: "c1" });
      await f.port.relateRecords(ctx(f.k, "r4"), { association: "AS1", first: a.id, second: "c1" });
    });

    it("a refused token is an auth failure (the connection pauses); it is never retried as if transient", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com" });
      f.revoke();
      await expect(f.port.addTags(ctx(f.k, "x"), id, ["a"])).rejects.toMatchObject({ failure: "auth" });
      expect((await f.k.state.connection(f.k.offerId, "crm"))!.status).not.toBe("connected");
    });
  });
}

// ---- messaging ------------------------------------------------------------------------------------------------------

export type MessagingFixture = { k: Kit; port: MessagingPort; seed(x: { phone?: string; email?: string }): Promise<string>; sent(): { channel: string; contactId: string; body?: string; subject?: string }[] };

export function messagingContract(name: string, make: () => Promise<MessagingFixture>) {
  describe(`messaging contract: ${name}`, () => {
    it("sends a text and an email to the contact, each once, and gives back the vendor's id", async () => {
      const f = await make();
      const id = await f.seed({ phone: "+15550100001", email: "ana@example.com" });
      const s = await f.port.sendSms(ctx(f.k, "s1"), { contactId: id, to: "+15550100001", body: "See you at 3" });
      const e = await f.port.sendEmail(ctx(f.k, "e1"), { contactId: id, to: "ana@example.com", subject: "Your call", body: "<p>Hi</p>" });
      expect(s.id).toBeTruthy();
      expect(e.id).toBeTruthy();
      expect(f.sent()).toEqual([expect.objectContaining({ channel: "sms", contactId: id, body: "See you at 3" }), expect.objectContaining({ channel: "email", contactId: id, subject: "Your call" })]);
    });
    it("refuses a text to a contact with no phone (permanent): nothing is sent", async () => {
      const f = await make();
      const id = await f.seed({ email: "ana@example.com" });
      await expect(f.port.sendSms(ctx(f.k, "s"), { contactId: id, to: null, body: "x" })).rejects.toMatchObject({ failure: "permanent" });
      expect(f.sent()).toEqual([]);
    });
  });
}

// ---- scheduling -----------------------------------------------------------------------------------------------------

export type SchedulingFixture = { k: Kit; port: SchedulingPort; book(): Promise<string>; status(id: string): string; supports: string[] };

export function schedulingContract(name: string, make: () => Promise<SchedulingFixture>) {
  describe(`scheduling contract: ${name}`, () => {
    it("cancels a booking", async () => {
      const f = await make();
      const id = await f.book();
      await f.port.cancel(ctx(f.k, "c"), { appointmentId: id, reason: "rebooked" });
      expect(f.status(id)).toBe("cancelled");
    });
    it("sets each status the vendor keeps; one it does not keep is refused for good", async () => {
      const f = await make();
      for (const s of f.supports) {
        const id = await f.book();
        await f.port.setStatus(ctx(f.k, `s-${s}`), { appointmentId: id, status: s });
        expect(f.status(id)).toBe(s);
      }
      for (const s of ["confirmed", "showed", "noshow"].filter((x) => !f.supports.includes(x))) {
        await expect(f.port.setStatus(ctx(f.k, `x-${s}`), { appointmentId: await f.book(), status: s })).rejects.toMatchObject({ failure: "permanent" });
      }
    });
  });
}

// ---- e-sign ---------------------------------------------------------------------------------------------------------

export type EsignFixture = { k: Kit; port: EsignPort; seed(): Promise<string>; sign(id: string): void };

export function esignContract(name: string, make: () => Promise<EsignFixture>) {
  describe(`esign contract: ${name}`, () => {
    it("sends an agreement, and its signing becomes agreement.signed (by the check, there being no webhook)", async () => {
      const f = await make();
      const contact = await f.seed();
      const { id } = await f.port.send(ctx(f.k, "e"), { contactId: contact, template: "TPL", name: "Agreement" });
      expect(id).toBeTruthy();
      f.sign(id);
      await f.k.runJobs(new Date(f.k.http.now().getTime() + 60_000));
      expect((await factsOf(f.k.store, f.k.offerId)).map((x) => [x.type, x.contactId])).toEqual([["agreement.signed", contact]]);
    });
  });
}

// ---- ai -------------------------------------------------------------------------------------------------------------

export type AiFixture = { k: Kit; port: Partial<AiPort>; answerWith(x: { status?: number; value?: string; confidence?: number; ambiguity?: number; text?: string; stop?: string }): void };

export function aiContract(name: string, verb: "classify" | "summarize", make: () => Promise<AiFixture>) {
  describe(`ai contract (${verb}): ${name}`, () => {
    if (verb === "classify") {
      const p = { input: "yes that works", prompt: "Is this a confirmation?", options: ["confirm", "cancel", "unclear"], threshold: 0.7, unclear: "unclear" };
      it("picks one of the options when it is confident, with its confidence and the other guesses", async () => {
        const f = await make();
        f.answerWith({ value: "confirm", confidence: 0.92 });
        const r = await f.port.classify!(ctx(f.k, "c"), p);
        expect(r).toMatchObject({ value: "confirm", confidence: 0.92 });
        expect(r.guesses.length).toBeGreaterThan(0);
      });
      it("below the threshold, or ambiguous, the answer is the step's unclear option (a person decides)", async () => {
        const f = await make();
        f.answerWith({ value: "confirm", confidence: 0.5 });
        expect((await f.port.classify!(ctx(f.k, "c1"), p)).value).toBe("unclear");
        f.answerWith({ value: "confirm", confidence: 0.95, ambiguity: 0.9 });
        expect((await f.port.classify!(ctx(f.k, "c2"), p)).value).toBe("unclear");
        f.answerWith({ value: "something_else", confidence: 0.99 });
        expect((await f.port.classify!(ctx(f.k, "c3"), p)).value).toBe("unclear");
      });
      it("a refused key is an auth failure; an outage is transient", async () => {
        const f = await make();
        f.answerWith({ status: 401 });
        await expect(f.port.classify!(ctx(f.k, "a"), p)).rejects.toMatchObject({ failure: "auth" });
        f.answerWith({ status: 503 });
        await expect(f.port.classify!(ctx(f.k, "b"), p)).rejects.toMatchObject({ failure: "transient" });
      });
    } else {
      const p = { prompt: "Summarize the call as JSON {summary, next_step}.", input: "Luis: hi Ana ...", format: "json" as const };
      it("reads the document against the prompt and gives back JSON (fences and preambles taken off)", async () => {
        const f = await make();
        f.answerWith({ text: 'Here it is:\n```json\n{"summary":"good","next_step":"agreement"}\n```' });
        expect(await f.port.summarize!(ctx(f.k, "s"), p)).toEqual({ summary: "good", next_step: "agreement" });
        f.answerWith({ text: "Plain words." });
        expect(await f.port.summarize!(ctx(f.k, "t"), { ...p, format: "text" })).toBe("Plain words.");
      });
      it("a refusal that stands is permanent; a refused key is auth; overload is transient", async () => {
        const f = await make();
        f.answerWith({ text: "", stop: "refusal" });
        await expect(f.port.summarize!(ctx(f.k, "r"), p)).rejects.toMatchObject({ failure: "permanent" });
        f.answerWith({ status: 401 });
        await expect(f.port.summarize!(ctx(f.k, "a"), p)).rejects.toMatchObject({ failure: "auth" });
        f.answerWith({ status: 529 });
        await expect(f.port.summarize!(ctx(f.k, "o"), p)).rejects.toMatchObject({ failure: "transient" });
      });
    }
  });
}

// ---- inbound ports: payments-in, recording, forms --------------------------------------------------------------------

/** A provider's door: it signs a body as the vendor would and delivers it, giving the door's answer. */
export type InboundFixture = {
  k: Kit;
  deliver(body: J, opts?: { id?: string; badSignature?: boolean }): Promise<Response>;
  /** Bodies modelled on the vendor's known shapes, by case. */
  samples: Record<string, J>;
  /** Makes the sample's person a known contact. */
  known(): Promise<string>;
};

async function factsAfter(f: InboundFixture, body: J, id?: string) {
  const res = await f.deliver(body, id ? { id } : {});
  expect(res.status).toBe(200);
  await f.k.runJobs();
  return factsOf(f.k.store, f.k.offerId);
}

async function doorBasics(f: InboundFixture, body: J) {
  const bad = await f.deliver(body, { badSignature: true });
  expect(bad.status).toBe(401);
  expect(await f.k.state.unprocessed()).toHaveLength(0);
  const first = await f.deliver(body, { id: "d-1" });
  expect(await first.json()).toEqual({ ok: true, duplicate: false });
  expect(await (await f.deliver(body, { id: "d-1" })).json()).toEqual({ ok: true, duplicate: true });
}

export function paymentsInContract(name: string, make: () => Promise<InboundFixture>) {
  describe(`payments-in contract: ${name}`, () => {
    it("refuses a bad signature and keeps nothing; a retry of a delivery is kept once", async () => { const f = await make(); await doorBasics(f, f.samples.succeeded!); });
    it("a payment from a known person is payment.received, linked; the same payment delivered again is one fact", async () => {
      const f = await make();
      const contact = await f.known();
      const facts = await factsAfter(f, f.samples.succeeded!);
      const pay = facts.filter((x) => x.type.startsWith("payment."));
      expect(pay).toEqual([expect.objectContaining({ type: "payment.received", contactId: contact, payload: expect.objectContaining({ amount: expect.any(Number), payment_id: expect.any(String), status: "succeeded", paid_at: expect.any(String) }) })]);
      await factsAfter(f, f.samples.succeeded!, "another-delivery");
      expect((await factsOf(f.k.store, f.k.offerId)).filter((x) => x.type.startsWith("payment."))).toHaveLength(1);
      expect((await f.k.store.tx((tx) => tx.projFind("payments", f.k.offerId)))[0]).toMatchObject({ contactId: contact, status: "succeeded" });
    });
    it("a payment from no known person is payment.unlinked (a person links it)", async () => {
      const f = await make();
      expect((await factsAfter(f, f.samples.succeeded!)).map((x) => x.type)).toEqual(["payment.unlinked"]);
    });
    it("a failure is payment.failed; a refund is payment.refunded, negative", async () => {
      const f = await make();
      await f.known();
      const facts = await factsAfter(f, f.samples.failed!);
      expect(facts.at(-1)!.type).toBe("payment.failed");
      const after = await factsAfter(f, f.samples.refunded!);
      expect(after.at(-1)).toMatchObject({ type: "payment.refunded", payload: expect.objectContaining({ status: "refunded" }) });
      expect(Number(after.at(-1)!.payload.amount)).toBeLessThan(0);
    });
  });
}

export function recordingContract(name: string, make: () => Promise<InboundFixture>) {
  describe(`recording contract: ${name}`, () => {
    it("refuses a bad signature and keeps nothing; a retry of a delivery is kept once", async () => { const f = await make(); await doorBasics(f, f.samples.meeting!); });
    it("a recording with a known prospect is recording.received on them; delivered again it is one fact", async () => {
      const f = await make();
      const contact = await f.known();
      const facts = await factsAfter(f, f.samples.meeting!);
      expect(facts.filter((x) => x.type.startsWith("recording."))).toEqual([expect.objectContaining({ type: "recording.received", contactId: contact, payload: expect.objectContaining({ recording_id: expect.any(String), recording: expect.objectContaining({ started_at: expect.any(String) }) }) })]);
      await factsAfter(f, f.samples.meeting!, "again");
      expect((await factsOf(f.k.store, f.k.offerId)).filter((x) => x.type === "recording.received")).toHaveLength(1);
    });
    it("a recording no one known is on is recording.unlinked", async () => {
      const f = await make();
      expect((await factsAfter(f, f.samples.meeting!)).map((x) => x.type)).toContain("recording.unlinked");
    });
  });
}

export function formsContract(name: string, make: () => Promise<InboundFixture>) {
  describe(`forms contract: ${name}`, () => {
    it("refuses a bad signature and keeps nothing; a retry of a delivery is kept once", async () => { const f = await make(); await doorBasics(f, f.samples.response!); });
    it("a submission is form.submitted with the person and the answers in canonical names; delivered again it is one fact", async () => {
      const f = await make();
      const facts = await factsAfter(f, f.samples.response!);
      expect(facts).toEqual([expect.objectContaining({ type: "form.submitted", payload: expect.objectContaining({ response_id: expect.any(String), contact: expect.objectContaining({ email: "ana@example.com" }), fields: expect.any(Object) }) })]);
      await factsAfter(f, f.samples.response!, "again");
      expect(await factsOf(f.k.store, f.k.offerId)).toHaveLength(1);
    });
    it("a submission from a known person is on that contact", async () => {
      const f = await make();
      const contact = await f.known();
      expect((await factsAfter(f, f.samples.response!))[0]!.contactId).toBe(contact);
    });
  });
}
