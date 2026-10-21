import { contactZoneOf, localDay, windowZone } from "./time";
import { definitionOf } from "./interpreter";
import { CONTACT_MESSAGES, type GateResult, gate } from "./gate";
import { SECRET_MARKER } from "./context";
import { type CallContext, type CrmContact, type FailureClass, PortError, type Ports, portOf } from "./ports";
import type { Store, Tx } from "./store";
import type { OutboxRow } from "./types";
import { recordFact } from "@/projections/apply";

/**
 * The outbox dispatcher: delivers effects the interpreter wrote. For each due row it
 * 1. claims it (a lease, committed), so no other worker takes it;
 * 2. reads the contact from the CRM when the effect reaches them (outside any transaction);
 * 3. applies the delivery gate and records every decision on the row; a row that goes on is marked `sending`, with
 *    its attempt time, before the vendor is called (committed);
 * 4. calls the port with the row's idempotency key (outside any transaction);
 * 5. records what happened and wakes the run waiting on it.
 *
 * Failures by class: transient is tried again with backoff and jitter (three tries in all); auth pauses the offer's
 * connection on that port, and the row waits for it; permanent fails the row, and the step's failure rule applies;
 * ambiguous (or anything the port did not classify) is `unknown`, and an unknown row is never sent again.
 */

export type DispatchDeps = {
  store: Store;
  ports: Ports;
  now: () => Date;
  /** A secret's value for an http.request, at the moment of the call. Never stored. */
  secret?: (offerId: string, key: string) => Promise<string | undefined>;
  /** 0 to 1, for jitter; the simulator passes a constant. */
  random?: () => number;
  worker?: string;
};

/** Minutes to wait after each failed try before the next (three tries in all). */
export const RETRY_DELAYS_MS = [60_000, 300_000];
export const MAX_TRIES = RETRY_DELAYS_MS.length + 1;
const LEASE_MS = 5 * 60_000;

export function backoff(attempt: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
  return Math.round(base * (0.8 + 0.4 * random()));
}

const scoped = (offerId: string, key: string) => `${offerId}:${key}`;

async function wakeOwner(tx: Tx, row: OutboxRow, now: Date) {
  const run = await tx.run(row.runId);
  if (run?.status === "waiting" && run.wake?.kind === "effect" && run.wake.outboxId === row.id) {
    await tx.updateRun(run.id, { nextWakeAt: now });
    await tx.schedule({ kind: "run", id: run.id, at: now });
  }
}

/** Rows a dispatcher marked sending and never finished (it stopped mid-call): their fate is unknown, so they are never sent again. */
export async function reapStale(d: DispatchDeps): Promise<number> {
  const now = d.now();
  return d.store.tx(async (tx) => {
    const rows = (await tx.outboxRows({ statuses: ["sending"] })).filter((r) => r.leaseUntil && r.leaseUntil < now);
    for (const r of rows) {
      await tx.updateOutbox(r.id, { status: "unknown", lastError: "the dispatcher stopped during the call: it may or may not have gone", errorClass: "ambiguous", settledAt: now, leaseOwner: null, leaseUntil: null });
      await tx.raiseAlert({ offerId: r.offerId, key: scoped(r.offerId, `unknown:${r.id}`), kind: "outbox_unknown", message: `It is not known whether ${r.kind} for step ${r.node} went out; it will not be sent again`, detail: {}, runId: r.runId, outboxId: r.id, openedAt: now });
      await wakeOwner(tx, { ...r, status: "unknown" }, now);
    }
    return rows.length;
  });
}

/** Delivers every row due now, one at a time. Gives back how many were looked at. */
export async function dispatchDue(d: DispatchDeps, limit = 100): Promise<number> {
  const due = await d.store.tx((tx) => tx.outboxRows({ statuses: ["queued"], dueBy: d.now(), limit }));
  let n = 0;
  for (const r of due) if (await deliver(d, r.id)) n++;
  return n;
}

type Claimed = { row: OutboxRow; gateInput: Omit<Parameters<typeof gate>[0], "contact" | "counts" | "now"> & { contactZoneFallback: string } };

/** Delivers one row if it is due. Gives back whether anything was done with it. */
export async function deliver(d: DispatchDeps, id: number): Promise<boolean> {
  const worker = d.worker ?? "dispatcher";
  const now = d.now();

  // 1. claim
  const claimed = await d.store.tx(async (tx): Promise<Claimed | undefined> => {
    const row = await tx.outboxRow(id, "skip");
    if (!row || row.status !== "queued" || !row.nextAttemptAt || row.nextAttemptAt > now) return undefined;
    if (row.leaseUntil && row.leaseUntil > now && row.leaseOwner !== worker) return undefined;
    const port = portOf(row.kind);
    // a connection refused its token: nothing goes through it (or, for a contact effect, past the CRM read) until it is fixed
    for (const p of row.effect === "contact" ? [port, "crm"] : [port]) { const c = await tx.connection(row.offerId, p); if (c && c.status !== "connected") return undefined; }
    const run = (await tx.run(row.runId))!;
    if (run.status === "ended" || run.status === "failed") {
      await tx.updateOutbox(row.id, { status: "suppressed", lastError: `the run ended (${run.endReason}) before this went out`, settledAt: now });
      return undefined;
    }
    const [wf, version, offer, settings, operator] = await Promise.all([tx.workflow(run.workflowId), tx.version(run.versionId), tx.offer(row.offerId), tx.settings(row.offerId), tx.operatorAddresses()]);
    const { def } = definitionOf(version!);
    await tx.updateOutbox(row.id, { leaseOwner: worker, leaseUntil: new Date(now.getTime() + LEASE_MS) });
    return {
      row,
      gateInput: {
        row, workflow: { delivery: wf!.delivery, crmWrites: wf!.crmWrites }, operator, settings, ...(def.sendWindow ? { sendWindow: def.sendWindow } : {}),
        windowZone: offer!.zone, offer: { sendsPausedAt: offer!.sendsPausedAt }, contactZoneFallback: offer!.zone,
      },
    };
  });
  if (!claimed) return false;
  const { row } = claimed;
  const call: CallContext = { offerId: row.offerId, idempotencyKey: row.idempotencyKey };

  // 2. who the contact is now, from the CRM (a vendor read: outside any transaction)
  let contact: CrmContact | null | undefined;
  if (row.effect === "contact") {
    if (!row.contactId) contact = null;
    else {
      try { contact = await d.ports.crm.getContact({ offerId: row.offerId, idempotencyKey: `${row.idempotencyKey}:read:${row.attempts + 1}` }, row.contactId); }
      catch (e) { return failed(d, row, e, "the contact could not be read from the CRM", "crm"); }
    }
  }

  // 3. the gate
  const decided = await d.store.tx(async (tx) => {
    if (row.contactId) await tx.lockKey(`cap:${row.offerId}:${row.contactId}`);
    const fresh = await tx.outboxRow(row.id, "wait");
    if (!fresh || fresh.status !== "queued") return undefined;
    const offer = (await tx.offer(row.offerId))!;
    const zone = contactZoneOf(contact ?? undefined, claimed.gateInput.contactZoneFallback);
    const day = localDay(now, zone);
    const isMessage = (CONTACT_MESSAGES as readonly string[]).includes(row.kind);
    const counts = {
      contactToday: isMessage && row.contactId ? await tx.countSends({ offerId: row.offerId, contactId: row.contactId, since: day.start, until: day.end, kinds: [...CONTACT_MESSAGES] }) : 0,
      offerLastHour: isMessage ? await tx.countSends({ offerId: row.offerId, since: new Date(now.getTime() - 3_600_000), kinds: [...CONTACT_MESSAGES] }) : 0,
      day: day.day,
    };
    const windowZoneFor = claimed.gateInput.sendWindow ? windowZone(claimed.gateInput.sendWindow, { now, offerZone: offer.zone, ...(zone !== offer.zone ? { contactZone: zone } : {}) }) : offer.zone;
    const result: GateResult = gate({ ...claimed.gateInput, offer: { sendsPausedAt: offer.sendsPausedAt }, windowZone: windowZoneFor, contact, counts, now });
    const gates = [...fresh.gates, ...result.checks];
    const target = result.decision === "send" ? await resolveTarget(tx, fresh, result.channel, claimed.gateInput.workflow.delivery === "sandbox") : undefined;
    if (target && "none" in target) {
      await tx.updateOutbox(row.id, { status: "suppressed", gates, lastError: target.none, settledAt: now, leaseOwner: null, leaseUntil: null });
      await wakeOwner(tx, fresh, now);
      return undefined;
    }
    if (result.alert) {
      const key = scoped(row.offerId, result.alert.key === "blank" ? `blank:${row.id}` : result.alert.key);
      await tx.raiseAlert({ offerId: row.offerId, key, kind: result.alert.kind, message: result.alert.message, detail: { node: row.node, kind: row.kind }, runId: row.runId, outboxId: row.id, openedAt: now });
    }
    if (result.tripBreaker) await tx.updateOffer(row.offerId, { sendsPausedAt: now, sendsPausedReason: result.alert?.message ?? "circuit breaker" });
    switch (result.decision) {
      case "suppress":
      case "hold":
        await tx.updateOutbox(row.id, { status: result.decision === "hold" ? "held" : "suppressed", gates, settledAt: now, leaseOwner: null, leaseUntil: null });
        await wakeOwner(tx, fresh, now);
        return undefined;
      case "defer":
        await tx.updateOutbox(row.id, { gates, nextAttemptAt: result.at!, leaseOwner: null, leaseUntil: null });
        await tx.schedule({ kind: "outbox", id: row.id, at: result.at! });
        return undefined;
      case "send":
        await tx.updateOutbox(row.id, { status: "sending", gates, attempts: fresh.attempts + 1, sentAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: worker });
        return { row: { ...fresh, attempts: fresh.attempts + 1 }, target: target!, sandbox: claimed.gateInput.workflow.delivery === "sandbox" };
    }
  });
  if (!decided) return true;

  // 4. the vendor call, with the idempotency key
  let result: unknown;
  try {
    result = await callPort(d, decided.row, decided.target, contact ?? null, call, decided.sandbox);
  } catch (e) {
    return failed(d, decided.row, e, undefined, portOf(row.kind));
  }

  // 5. what happened
  await d.store.tx(async (tx) => {
    const done = d.now();
    await tx.updateOutbox(row.id, { status: "sent", result: (result ?? null) as never, settledAt: done, leaseOwner: null, leaseUntil: null });
    const posted = result as { channel?: string; ts?: string; edited?: number } | null;
    const tag = (row.payload.remember as string | undefined) ?? null;
    if ((row.kind === "message.slack" || row.kind === "slack.ask") && posted?.ts) {
      // a post said again in place stays one post: it now belongs to this row and step, under its tag
      if (posted.edited !== undefined) await tx.updatePost(posted.edited, { outboxId: row.id, runId: row.runId, node: row.node, tag });
      else await tx.insertPost({ offerId: row.offerId, outboxId: row.id, runId: row.runId, node: row.node, tag, channel: posted.channel!, ts: posted.ts, sandbox: decided.sandbox, createdAt: done });
    }
    await recordWritten(tx, row, result, done);
    await wakeOwner(tx, decided.row, done);
  });
  return true;
}

/**
 * What a CRM write that went through made, kept as a fact about the contact: the record we wrote (its key and the
 * CRM's id), the deal we moved (its id, pipeline and stage), the status we set. The projections read these (a
 * contact's records and cards), so what we did is history, not a copy of the CRM. A dry write made nothing.
 */
async function recordWritten(tx: Tx, row: OutboxRow, result: unknown, at: Date): Promise<void> {
  const params = (row.payload.params ?? {}) as Record<string, unknown>;
  const id = (result as { id?: unknown } | null)?.id;
  const fact = row.kind === "crm.upsert_record" && id !== undefined ? { type: "crm.record_written", payload: { object: params.object ?? null, key: params.key ?? null, record_id: String(id) } }
    : row.kind === "crm.move_deal" && id !== undefined ? { type: "crm.deal_written", payload: { deal_id: String(id), pipeline: params.pipeline ?? null, stage: params.stage ?? null, status: "open", name: params.name ?? null, owner: params.owner ?? null, value: params.value ?? null } }
      : row.kind === "crm.set_deal_status" ? { type: "crm.deal_status_set", payload: { pipeline: params.pipeline ?? null, status: params.status ?? null } }
        : undefined;
  if (!fact || !row.contactId) return;
  await recordFact(tx, { offerId: row.offerId, type: fact.type, occurredAt: at, contactId: row.contactId, appointmentId: (row.payload.appointmentId as string | undefined) ?? null, dealId: null, source: "engine", dedupeKey: `outbox:${row.id}`, payload: fact.payload as never, runId: row.runId });
}

type Target = { channel?: string; dm?: string; threadTs?: string; post?: { channel: string; ts: string }; edit?: { id: number; channel: string; ts: string } } | { none: string };

/**
 * Where a Slack effect goes: the channel (or the sandbox's test channel), the post it threads under or acts on, or,
 * for a post said again in place (`edit`), the earlier post it rewrites: the one remembered under its tag, made the same
 * way (sandbox or live, and in the test channel when rerouted there).
 */
async function resolveTarget(tx: Tx, row: OutboxRow, reroute: string | undefined, sandbox: boolean): Promise<Target> {
  const p = row.payload as { channel?: string; dm?: string; thread?: { node?: string; tag?: string }; threadOnly?: boolean; remember?: string; edit?: boolean; params?: { post?: { node?: string; tag?: string } } };
  const findPost = async (ref: { node?: string; tag?: string }) => (await tx.posts({ offerId: row.offerId, ...(ref.node ? { runId: row.runId, node: ref.node } : { tag: ref.tag! }) }))[0];
  if (row.kind === "message.slack" || row.kind === "slack.ask") {
    if (row.kind === "message.slack" && p.edit && p.remember) {
      const earlier = await findPost({ tag: p.remember });
      if (earlier && earlier.sandbox === sandbox && (!reroute || earlier.channel === reroute)) return { edit: { id: earlier.id, channel: earlier.channel, ts: earlier.ts } };
    }
    const out: { channel?: string; dm?: string; threadTs?: string } = reroute ? { channel: reroute } : p.dm ? { dm: p.dm } : { channel: p.channel! };
    if (p.thread) {
      const parent = await findPost(p.thread);
      if (parent && out.channel && parent.channel === out.channel) out.threadTs = parent.ts;
      // a reply under a post the app made in a DM goes in that DM's thread, wherever the DM is (as a reply under a post does)
      else if (parent && out.dm && (await tx.outboxRow(parent.outboxId))?.payload.dm) return { channel: parent.channel, threadTs: parent.ts };
      else if (p.threadOnly) return { none: "there is no post to reply under" };
    }
    return out;
  }
  if (row.kind.startsWith("slack.")) {
    const ref = p.params?.post;
    const post = ref ? await findPost(ref) : undefined;
    return post ? { post: { channel: post.channel, ts: post.ts } } : { none: "the post it acts on is not there" };
  }
  return {};
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

async function callPort(d: DispatchDeps, row: OutboxRow, target: Exclude<Target, { none: string }>, contact: CrmContact | null, c: CallContext, sandbox: boolean): Promise<unknown> {
  const p = row.payload as Record<string, unknown> & { params?: Record<string, unknown>; content?: Record<string, { text: string; subject?: string }>; text?: string; subject?: string; as?: string; icons?: unknown };
  const params = p.params ?? {};
  const needContact = () => { if (!row.contactId) throw new PortError("permanent", "the run has no contact"); return row.contactId; };
  const contentText = (key: unknown) => p.content?.[str(key)]?.text ?? "";
  const { crm, messaging, scheduling, esign, ai, slack, http } = d.ports;
  switch (row.kind) {
    case "message.sms": return messaging.sendSms(c, { contactId: needContact(), to: contact?.phone ?? null, body: str(p.text) });
    case "message.email": return messaging.sendEmail(c, { contactId: needContact(), to: contact?.email ?? null, subject: str(p.subject), body: str(p.text) });
    case "message.slack":
    case "slack.ask": {
      const answers = row.kind === "slack.ask" ? p.answers : undefined;
      const buttons = (p.buttons as never) ?? undefined;
      const persona = { ...(p.as ? { as: p.as } : {}), ...(Array.isArray(p.icons) && p.icons.length ? { icons: p.icons as string[] } : {}) };
      const t = target as { channel?: string; dm?: string; threadTs?: string; edit?: { id: number; channel: string; ts: string } };
      if (t.edit) {
        await slack.update(c, { channel: t.edit.channel, ts: t.edit.ts, text: str(p.text), ...(buttons ? { buttons } : {}) });
        return { channel: t.edit.channel, ts: t.edit.ts, edited: t.edit.id };
      }
      if (t.dm) return slack.dm(c, { user: t.dm, text: str(p.text), ...persona, ...(buttons ? { buttons } : {}), ...(answers ? { answers } : {}) });
      return slack.post(c, { channel: t.channel!, text: str(p.text), ...persona, ...(t.threadTs ? { threadTs: t.threadTs } : {}), ...(buttons ? { buttons } : {}), ...(answers ? { answers } : {}), sandbox });
    }
    case "slack.react": case "slack.unreact": {
      const post = (target as { post: { channel: string; ts: string } }).post;
      return slack[row.kind === "slack.react" ? "react" : "unreact"](c, { ...post, emojis: params.emojis as string[] });
    }
    case "slack.update_post": return slack.update(c, { ...(target as { post: { channel: string; ts: string } }).post, text: contentText(params.content) });
    case "crm.find_or_create_contact": return crm.findOrCreateContact(c, row.contactId, params);
    case "crm.update_contact": return crm.updateContact(c, needContact(), params);
    case "crm.add_tag": return crm.addTags(c, needContact(), params.tags as string[]);
    case "crm.remove_tag": return crm.removeTags(c, needContact(), params.tags as string[]);
    case "crm.mark_dnd": return crm.markDnd(c, needContact(), params.channel as "sms" | "email" | "all");
    case "crm.move_deal": return crm.moveDeal(c, needContact(), params);
    case "crm.set_deal_status": return crm.setDealStatus(c, needContact(), params);
    case "crm.update_deal": return crm.updateDeal(c, needContact(), params);
    case "crm.create_task": return crm.createTask(c, needContact(), { ...params, title: contentText(params.title), ...(params.body ? { body: contentText(params.body) } : {}) });
    case "crm.add_note": return crm.addNote(c, needContact(), contentText(params.content));
    case "crm.upsert_record": return crm.upsertRecord(c, params);
    case "crm.relate_records": return crm.relateRecords(c, params);
    case "scheduling.cancel": return scheduling.cancel(c, { appointmentId: str(params.appointment), ...(params.reason ? { reason: str(params.reason) } : {}) });
    case "scheduling.set_status": return scheduling.setStatus(c, { appointmentId: str(params.appointment), status: str(params.status) });
    case "esign.send": return esign.send(c, { contactId: needContact(), template: str(params.template), ...(params.sender ? { sender: str(params.sender) } : {}), ...(params.name ? { name: str(params.name) } : {}) });
    case "esign.void": return esign.void(c, { agreementId: str(params.agreement) });
    case "ai.classify": return ai.classify(c, { ...params, prompt: contentText(params.prompt) } as never);
    case "ai.summarize": return ai.summarize(c, { ...params, prompt: contentText(params.prompt) } as never);
    case "http.request": {
      const filled = await fillSecrets(d, row.offerId, params);
      return http.request(c, filled as never);
    }
    default: throw new PortError("permanent", `no port verb for ${row.kind}`);
  }
}

/** A secret marker in an http.request's params, replaced by the secret at the moment of the call. */
async function fillSecrets(d: DispatchDeps, offerId: string, v: unknown): Promise<unknown> {
  if (typeof v === "string") {
    let out = v;
    for (const m of v.matchAll(SECRET_MARKER)) {
      const value = await d.secret?.(offerId, m[1]!);
      if (value === undefined) throw new PortError("permanent", `the secret ${m[1]} is not set`);
      out = out.replace(m[0], value);
    }
    return out;
  }
  if (Array.isArray(v)) return Promise.all(v.map((x) => fillSecrets(d, offerId, x)));
  if (v && typeof v === "object") return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await fillSecrets(d, offerId, x)])));
  return v;
}

/** Records a failed call (or a failed read of the contact before it) by its class. */
async function failed(d: DispatchDeps, row: OutboxRow, e: unknown, before: string | undefined, port: string): Promise<boolean> {
  const cls: FailureClass = e instanceof PortError ? e.failure : "ambiguous";
  const message = `${before ? `${before}: ` : ""}${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
  const now = d.now();
  await d.store.tx(async (tx) => {
    const cur = (await tx.outboxRow(row.id, "wait"))!;
    const tries = before ? cur.attempts + 1 : cur.attempts;
    const base = { lastError: message, errorClass: cls, leaseOwner: null, leaseUntil: null };
    if (cls === "auth") {
      // a connection already held for a reason of its own (it needs a reinstall, it was uninstalled) keeps that reason
      const held = await tx.connection(row.offerId, port);
      if (!held || held.status === "connected") await tx.setConnection({ offerId: row.offerId, port, status: "paused", reason: message, pausedAt: now });
      await tx.raiseAlert({ offerId: row.offerId, key: scoped(row.offerId, `auth:${port}`), kind: "connection_auth", message: `The ${port} connection refused its token; everything through it waits until it is fixed: ${message}`, detail: {}, runId: null, outboxId: row.id, openedAt: now });
      // the call was refused, so it did not happen: the row goes back to the queue, to wait for the connection
      await tx.updateOutbox(row.id, { ...base, status: "queued", nextAttemptAt: now, sentAt: null });
      return;
    }
    if (cls === "ambiguous" && !before) {
      await tx.updateOutbox(row.id, { ...base, status: "unknown", settledAt: now });
      await tx.raiseAlert({ offerId: row.offerId, key: scoped(row.offerId, `unknown:${row.id}`), kind: "outbox_unknown", message: `It is not known whether ${row.kind} for step ${row.node} went out; it will not be sent again`, detail: {}, runId: row.runId, outboxId: row.id, openedAt: now });
      await wakeOwner(tx, cur, now);
      return;
    }
    if ((cls === "transient" || (cls === "ambiguous" && before)) && tries < MAX_TRIES) {
      const at = new Date(now.getTime() + backoff(tries, d.random ?? Math.random));
      await tx.updateOutbox(row.id, { ...base, status: "queued", attempts: tries, nextAttemptAt: at, sentAt: null });
      await tx.schedule({ kind: "outbox", id: row.id, at });
      return;
    }
    await tx.updateOutbox(row.id, { ...base, status: "failed", attempts: tries, settledAt: now });
    await tx.raiseAlert({ offerId: row.offerId, key: scoped(row.offerId, `failed:${row.id}`), kind: "outbox_failed", message: `${row.kind} for step ${row.node} failed (${cls}${cls === "transient" ? `, after ${tries} tries` : ""}): ${message}`, detail: {}, runId: row.runId, outboxId: row.id, openedAt: now });
    await wakeOwner(tx, cur, now);
  });
  return true;
}

/** A person fixed the connection's token: everything waiting on it is due now. */
export async function resumeConnection(store: Store, offerId: string, port: string, now: Date): Promise<number> {
  return store.tx(async (tx) => {
    await tx.setConnection({ offerId, port, status: "connected", reason: null, pausedAt: null });
    await tx.resolveAlert(scoped(offerId, `auth:${port}`), now);
    const rows = (await tx.outboxRows({ offerId, statuses: ["queued"] })).filter((r) => portOf(r.kind) === port);
    for (const r of rows) { await tx.updateOutbox(r.id, { nextAttemptAt: now }); await tx.schedule({ kind: "outbox", id: r.id, at: now }); }
    return rows.length;
  });
}

/** An operator clears a tripped breaker: messages to contacts may go again (held ones stay held). */
export async function clearBreaker(store: Store, offerId: string, now: Date): Promise<void> {
  await store.tx(async (tx) => {
    await tx.updateOffer(offerId, { sendsPausedAt: null, sendsPausedReason: null });
    await tx.resolveAlert(scoped(offerId, "breaker"), now);
  });
}
