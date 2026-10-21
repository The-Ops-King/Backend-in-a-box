import { eq } from "drizzle-orm";
import type { TaskList } from "graphile-worker";
import { inbox } from "@/db/schema";
import { type SlackApp, type SlackTask, outDeps } from "./app";
import { agreementCommandNow } from "./agreement";
import { announceAlerts } from "./alerts";
import { handleCommand, parseCommand } from "./commands";
import { searchContacts } from "./contacts";
import { handleEvent } from "./events";
import { handleInteraction, interactNow, parseInteraction } from "./interactions";
import { deliverDueSlack, deliverSlack } from "./outbox";
import { may, presserOf } from "./people";
import { openValue } from "./signed";
import { verifySlackRequest } from "./signature";

/**
 * The Slack doors: /slack/events, /slack/interactions, /slack/commands, /slack/options. Each request is checked with
 * the v0 signature and the five-minute window before anything reads it (a failure is logged without the body and
 * answered 401). A retry Slack marks with X-Slack-Retry-Num is acked and dropped. Each delivery is kept once in the
 * inbox (an event by its event_id, a press by its trigger, a command by its trigger id): a repeat is acked and does
 * nothing. Then the door answers at once, and the work runs as a job, so a slow vendor never makes Slack time out.
 */
export type Door = "events" | "interactions" | "commands" | "options";

const ok = (body?: unknown) => (body === undefined ? new Response(null, { status: 200 }) : Response.json(body));

function headersOf(req: Request) {
  return Object.fromEntries([...req.headers.entries()].filter(([k]) => k.startsWith("x-slack-") || k === "content-type"));
}

/** Keeps a delivery once; undefined when it was already kept (a repeat). */
async function keep(app: SlackApp, x: { deliveryId: string; eventType: string; headers: Record<string, string>; body: string; teamId: string | null }): Promise<number | undefined> {
  const rows = await app.db.insert(inbox).values({ source: "slack", deliveryId: x.deliveryId, eventType: x.eventType, locationId: x.teamId, headers: x.headers, body: x.body }).onConflictDoNothing().returning({ id: inbox.id });
  return rows[0]?.id;
}

export async function slackDoor(app: SlackApp, door: Door, req: Request): Promise<Response> {
  const raw = await req.text();
  const v = verifySlackRequest(app.env.signingSecret, { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") }, raw, app.now());
  if (!v.ok) {
    console.warn(`slack ${door}: refused (${v.why})`);
    return Response.json({ error: v.why }, { status: 401 });
  }
  if (req.headers.get("x-slack-retry-num")) return ok();
  const headers = headersOf(req);
  if (door === "events") {
    let body: Record<string, any>;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: "not JSON" }, { status: 400 }); }
    if (body.type === "url_verification") return ok({ challenge: body.challenge });
    if (body.type !== "event_callback" || typeof body.event_id !== "string") return ok();
    const id = await keep(app, { deliveryId: `event:${body.event_id}`, eventType: `event:${String(body.event?.type ?? "?")}`, headers, body: raw, teamId: typeof body.team_id === "string" ? body.team_id : null });
    if (id !== undefined) await app.enqueue("slack_inbox", { id });
    return ok();
  }
  const form = new URLSearchParams(raw);
  if (door === "commands") {
    const cmd = parseCommand(form);
    if (!cmd) return ok();
    const id = await keep(app, { deliveryId: `command:${cmd.teamId}:${cmd.triggerId ?? `${cmd.userId}:${req.headers.get("x-slack-request-timestamp")}`}`, eventType: `command:${cmd.command}`, headers, body: raw, teamId: cmd.teamId });
    if (id === undefined) return ok();
    if (cmd.command.toLowerCase() === "/agreement" && (await agreementCommandNow(app, cmd).catch((e) => { console.error("slack /agreement form:", e); return false; }))) return ok();
    await app.enqueue("slack_inbox", { id });
    return ok();
  }
  let payload: unknown;
  try { payload = JSON.parse(form.get("payload") ?? ""); } catch { return Response.json({ error: "no payload" }, { status: 400 }); }
  const x = parseInteraction(payload);
  if (door === "options") {
    if (x.type !== "block_suggestion") return ok({ options: [] });
    return ok({ options: await suggestions(app, x) });
  }
  if (x.type === "ignored" || x.type === "block_suggestion") return ok();
  const p = payload as Record<string, any>;
  const key = x.type === "block_actions" ? `action:${x.teamId}:${x.userId}:${x.actionTs ?? p.trigger_id ?? ""}:${x.actionId}` : `view:${x.teamId}:${p.view?.id ?? ""}:${p.view?.hash ?? p.trigger_id ?? ""}`;
  const id = await keep(app, { deliveryId: key, eventType: `interaction:${x.type}`, headers, body: raw, teamId: x.teamId });
  if (id === undefined) return ok();
  const now = await interactNow(app, x).catch((e) => { console.error("slack interaction:", e); return { job: true } as { body?: unknown; job: boolean }; });
  if (now.job) await app.enqueue("slack_inbox", { id });
  return ok(now.body);
}

/** The contact search behind a modal's menu: the offer from the modal's signed metadata, for someone who may link. */
async function suggestions(app: SlackApp, x: { teamId: string; userId: string; query: string; meta: string }) {
  const m = openValue<{ o: string; k?: string }>(app.env.stateSecret, "modal", x.meta, app.now());
  if (!m?.o) return [];
  const who = await presserOf(app, m.o, x.teamId, x.userId);
  // the Link modal's metadata names what it links; the agreement form's does not
  if (!may(who, m.k ? "link" : "agreement")) return [];
  return (await searchContacts(app.db, m.o, x.query, 20)).map((c) => ({ text: { type: "plain_text", text: `${c.name}${c.email ? ` · ${c.email}` : c.phone ? ` · ${c.phone}` : ""}`.slice(0, 75) }, value: c.id }));
}

/** One kept delivery's work (the slack_inbox job). */
export async function processInbox(app: SlackApp, id: number): Promise<string> {
  const row = (await app.db.select().from(inbox).where(eq(inbox.id, id)))[0];
  if (!row || row.source !== "slack") return "no such delivery";
  const kind = row.eventType ?? "";
  if (kind.startsWith("event:")) {
    const body = JSON.parse(row.body);
    try { return await handleEvent(app, body, id); }
    finally {
      // what a person wrote to the bot is used for the answer, then not kept: the delivery keeps its ids, not its words
      if (kind === "event:app_mention" || kind === "event:message") {
        const e = body.event ?? {};
        await app.db.update(inbox).set({ body: JSON.stringify({ ...body, event: { ...e, text: "", blocks: undefined, attachments: undefined, files: undefined } }) }).where(eq(inbox.id, id));
      }
    }
  }
  const form = new URLSearchParams(row.body);
  if (kind.startsWith("command:")) { const cmd = parseCommand(form); return cmd ? handleCommand(app, cmd, id) : "bad command"; }
  if (kind.startsWith("interaction:")) {
    const payload = JSON.parse(form.get("payload") ?? "{}");
    try { return await handleInteraction(app, parseInteraction(payload), id); }
    finally {
      // a pick under a DM question carries the question in its value: used, then not kept
      if (payload.type === "block_actions" && (payload.actions ?? [])[0]?.action_id === "pick") {
        const kept = { ...payload, actions: payload.actions.map((a: Record<string, unknown>) => ({ ...a, value: "" })) };
        await app.db.update(inbox).set({ body: new URLSearchParams({ payload: JSON.stringify(kept) }).toString() }).where(eq(inbox.id, id));
      }
    }
  }
  return "unknown delivery";
}

/** What each Slack job does. */
export async function runSlackJob(app: SlackApp, task: SlackTask, payload: Record<string, unknown>): Promise<unknown> {
  if (task === "slack_inbox") return processInbox(app, Number(payload.id));
  if (task === "slack_outbox") return deliverSlack(outDeps(app), Number(payload.id));
  const said = await announceAlerts(app);
  await deliverDueSlack(outDeps(app));
  return said;
}

/** The Slack jobs for graphile-worker, beside the engine's (src/engine/jobs.ts). The alert sweep is a cron item: `* * * * * slack_alerts`. */
export const slackTaskList = (app: SlackApp): TaskList => ({
  slack_inbox: async (p) => { await runSlackJob(app, "slack_inbox", p as Record<string, unknown>); },
  slack_outbox: async (p) => { await runSlackJob(app, "slack_outbox", p as Record<string, unknown>); },
  slack_alerts: async () => { await runSlackJob(app, "slack_alerts", {}); },
});
