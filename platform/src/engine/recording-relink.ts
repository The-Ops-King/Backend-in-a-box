import type { PoolClient } from "pg";
import { many, one } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import { loadCompany } from "./context";
import { slackBot } from "./slack-conn";
import { contactTags } from "./contact-ops";
import { undoRunWrites } from "./undo";
import { fittingBooking, linkRecording, placeCall, resolveRecording, type Placed, type RecordingInput, type RecordingRow } from "./recordings";

/**
 * D227: a recording linked to the wrong person is moved, and everything it set off on them is put back (Tyler: "the resolve should
 * do all those steps"). POST /api/admin/recordings/relink { company, recording, to: "rules" | "none" | <contact id>, why, dryRun = true }.
 *
 * - `to`: "rules" links it where the matching rules say now (reading the transcript again from Fathom when it is no longer held);
 *   "none" leaves it linked to no one; a contact id links it to that person, on their booking the recording fits.
 * - The wrong person, from what the runs this recording started on them wrote (and only that): their booking's outcome back to what
 *   it was before (the outcome event says), the tags those runs added taken off, the card those runs moved back to the stage it came
 *   from, the records, cards and tasks those runs made deleted (D142's undo; a record they only updated is named, not touched), the
 *   call note deleted when exactly one note was written then, and the Slack posts those runs made edited to say the call was not theirs.
 * - The right person: linked as a person linking it would (the Sales call recorded workflow runs on them); the invite's email is not
 *   remembered for them, since the invite was what was wrong. D274: `backfill: true` links them and files the call on their booking but
 *   starts no workflow (an old call: no late review, Slack post or note; Tyler: "backfill first, then we can turn it on for the future").
 * A dry run says all of it. Audited.
 */
export type RelinkAsk = { company: string; recording: string; to: string; why: string; dryRun?: boolean; backfill?: boolean; by?: string };
type Done = { what: string; done?: boolean; error?: string };
export type RelinkResult = { ok: true; dryRun: boolean; recording: string; from: { contact: string; name: string; appointment: string | null } | null; to: { contact: string; name: string; appointment: string | null; by: string; placed?: Placed } | { linked: false; reason: string }; undo: Done[]; kept: string[]; workflows: "start" | "none"; runs_started?: number }
  | { ok: false; status: number; error: string };

const UUID = /^[0-9a-f-]{36}$/i;

export async function relinkRecording(c: PoolClient, adapters: Adapters, a: RelinkAsk): Promise<RelinkResult> {
  if (!a.why?.trim()) return { ok: false, status: 400, error: "why is required" };
  if (!UUID.test(a.recording ?? "")) return { ok: false, status: 400, error: "recording (its id) is required" };
  const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [a.company]); if (!co) return { ok: false, status: 404, error: "no such company" };
  const r = await one<RecordingRow>(c, "select * from recordings where company_id=$1 and id=$2", [co.id, a.recording]); if (!r) return { ok: false, status: 404, error: "no such recording" };
  const { adapterCompany: ac, bindings } = await loadCompany(c, co.id);
  const nameOf = async (id: string) => (await one<{ n: string }>(c, "select trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as n from contacts where id=$1", [id]))?.n || "someone";

  // where it goes
  let target: { contact: string; appointment: string | null; by: string; placed?: Placed } | { reason: string };
  if (a.to === "none") target = { reason: `unlinked by the operator: ${a.why.trim()}` };
  else if (a.to === "rules") {
    let transcript = r.transcript;
    if (!transcript?.length && r.provider === "fathom" && bindings["secret.fathom_api_key"] && adapters.recorder) {
      try { transcript = await adapters.recorder.transcript(bindings["secret.fathom_api_key"], r.external_id); } catch (e) { return { ok: false, status: 502, error: `Fathom: ${String((e as Error).message).slice(0, 200)}` }; }
    }
    // who spoke is what the rules weigh most: a move is never made on the invite alone because Fathom did not answer this time
    if (!transcript?.length && r.provider === "fathom") return { ok: false, status: 409, error: "Fathom gave no transcript for this recording just now, so who spoke cannot be read: try again, or name the contact (or \"none\")" };
    const input: RecordingInput = { provider: r.provider, externalId: r.external_id, startedAt: r.started_at, recordedBy: { name: r.recorded_by_name ?? undefined, email: r.recorded_by_email ?? undefined }, invitees: r.invitees ?? [], transcript: transcript ?? undefined };
    const res = await resolveRecording(c, co.id, input);
    target = res.match ? { contact: res.match.contactId, appointment: res.match.appointmentId ?? null, by: res.match.by, placed: res.match.placed } : { reason: res.reason ?? "no match" };
  } else {
    if (!UUID.test(a.to) || !(await one(c, "select 1 from contacts where company_id=$1 and id=$2", [co.id, a.to]))) return { ok: false, status: 404, error: "to: no such contact (a contact id, \"rules\" or \"none\")" };
    const fit = await fittingBooking(c, co.id, a.to, r.started_at), p = fit ? null : await placeCall(c, co.id, a.to, r.started_at);
    target = { contact: a.to, appointment: fit ?? p!.appointmentId, by: "manual", ...(p ? { placed: p.placed } : {}) };
  }
  const same = "contact" in target && r.contact_id === target.contact && (r.appointment_id ?? null) === target.appointment;
  if (same) return { ok: false, status: 409, error: "the recording is already linked there" };

  // what it set off on the person it was linked to
  const steps: { what: string; run: () => Promise<void>; first?: boolean }[] = [], kept: string[] = [];
  const add = (what: string, run: () => Promise<void>, first = false) => steps.push({ what, run, first });
  const old = r.contact_id ? { contact: r.contact_id, name: await nameOf(r.contact_id), appointment: r.appointment_id } : null;
  const runs = old ? await many<{ id: string; started_at: Date; finished_at: Date | null }>(c, `select r.id, r.started_at, r.finished_at from runs r join events e on e.id=r.triggered_by_event
    where r.company_id=$1 and r.contact_id=$2 and e.data->>'recording_id'=$3 order by r.started_at`, [co.id, old.contact, r.id]) : [];
  const runIds = runs.map((x) => x.id);
  // D236: the same person, another booking (a call held late, a follow-up on their sale): what is theirs stays (tags, card, the Slack
  // review, which the run on the right booking edits in place); only what was about the booking or made twice is put back
  const samePerson = !!old && "contact" in target && target.contact === old.contact;
  if (old && runIds.length) {
    // the booking's outcome, back to what it was before the first of them set it
    const set = old.appointment ? await one<{ data: { previous_outcome: string | null; previous_call_outcome: string | null } }>(c, `select data from events where company_id=$1 and appointment_id=$2 and event_type='appointment.outcome' and run_id = any($3::uuid[]) order by id limit 1`, [co.id, old.appointment, runIds]) : null;
    if (set && old.appointment) {
      const prev = set.data.previous_outcome, prevCall = set.data.previous_call_outcome;
      add(`${old.name}'s booking: outcome back to ${prev ?? "none"}, call outcome back to ${prevCall ?? "none"}`, async () => {
        const term = async (domain: string, cat: string | null) => (cat ? (await one<{ id: string }>(c, "select id from company_terms where company_id=$1 and domain=$2 and category=$3 order by is_default desc limit 1", [co.id, domain, cat]))?.id ?? null : null);
        await c.query(`update appointments set outcome_term=$2, call_outcome_term=$3, dispositioned_at=case when $2::uuid is null then null else dispositioned_at end, dispositioned_by=case when $2::uuid is null then null else dispositioned_by end where id=$1`,
          [old.appointment, await term("appointment_outcome", prev), await term("call_outcome", prevCall)]);
      });
    }
    // tags those runs added
    const tags = (await many<{ tag: string }>(c, "select distinct data->>'tag' as tag from events where company_id=$1 and contact_id=$2 and event_type='tag.added' and run_id = any($3::uuid[]) and data->>'tag' is not null", [co.id, old.contact, runIds])).map((t) => t.tag);
    if (tags.length && !samePerson) { add(`${old.name}: tag${tags.length > 1 ? "s" : ""} ${tags.join(", ")} off`, async () => { const t = await contactTags(c, adapters, { company: a.company, contact: old.contact, remove: tags, why: a.why, dryRun: false }); if (!t.ok) throw new Error(t.error); }); }
    // the card those runs moved: back to the stage it came from
    const moves = await many<{ result: { from_stage?: string; crm_card?: string; card?: string } }>(c, "select s.result from run_steps s where s.run_id = any($1::uuid[]) and s.node_type='pipeline_card' and s.status='ok' and s.result->>'card'='moved' order by s.started_at", [runIds]);
    const first = new Map<string, string>();
    for (const m of moves) if (m.result.crm_card && m.result.from_stage && !first.has(m.result.crm_card)) first.set(m.result.crm_card, m.result.from_stage);
    for (const [card, stage] of samePerson ? [] : first) {
      const row = await one<{ ghl_pipeline_id: string; name: string; ghl_stage_id: string }>(c, "select ghl_pipeline_id, name, ghl_stage_id from pipeline_cards where company_id=$1 and ghl_opportunity_id=$2", [co.id, card]);
      if (!row) { kept.push(`card ${card}: no longer the engine's, not moved back`); continue; }
      add(`${old.name}'s card "${row.name}": back to the stage it came from (${stage}), open`, async () => { await adapters.write.updateOpportunity(ac, card, { pipelineId: row.ghl_pipeline_id, stageId: stage, status: "open" }); await c.query("update pipeline_cards set ghl_stage_id=$2, status='open', updated_at=now() where company_id=$1 and ghl_opportunity_id=$3", [co.id, stage, card]); });
    }
    // what they made: records, cards, tasks (D142); a record they only updated is named
    const made = await undoRunWrites(c, adapters, { company: a.company, runs: runIds, why: a.why, dryRun: true });
    if (made.ok) {
      kept.push(...made.kept);
      if (made.writes.length) add(made.writes.map((w) => `delete the ${w.kind} ${w.external_id}${w.object ? ` (${w.object})` : ""} it made on ${old.name}`).join("; "), async () => { const u = await undoRunWrites(c, adapters, { company: a.company, runs: runIds, why: a.why, dryRun: false, by: a.by }); if (!u.ok) throw new Error(u.error); const bad = u.writes.filter((w) => w.error); if (bad.length) throw new Error(bad.map((w) => w.error).join("; ")); }, true);
    }
    // a record a run of theirs wrote (its step passed) that was there before the run: named, not touched
    const updated = await many<{ ghl_record_id: string; object_key: string }>(c, `select distinct k.ghl_record_id, k.object_key from run_steps s join runs r on r.id=s.run_id join crm_records k on k.company_id=r.company_id and k.ghl_record_id=s.result->>'crm_id'
      where s.run_id = any($1::uuid[]) and s.node_type='crm_record' and s.status='ok' and k.created_at < r.started_at`, [runIds]);
    for (const u of updated) kept.push(`${u.object_key} record ${u.ghl_record_id} on ${old.name} was made before and updated by the call: check its fields in GHL`);
    // the call note: the one note written while a run wrote one
    const noted = await many<{ done_at: Date }>(c, "select done_at from step_effects where run_id = any($1::uuid[]) and kind='note' and done_at is not null", [runIds]);
    const ghlContact = (await one<{ g: string | null }>(c, "select ghl_contact_id as g from contacts where id=$1", [old.contact]))?.g;
    if (noted.length && ghlContact && adapters.read.contactNotes) {
      const notes = await adapters.read.contactNotes(ac, ghlContact);
      for (const n of noted) {
        const near = notes.filter((x) => Math.abs(Date.parse(x.dateAdded) - n.done_at.getTime()) <= 3 * 60e3);
        if (near.length !== 1 || !adapters.write.deleteNote) { kept.push(`the call note written on ${old.name} at ${n.done_at.toISOString()}: ${near.length} notes then, so it is left for a person`); continue; }
        add(`delete the call note on ${old.name} (${near[0].body.split("\n")[0].slice(0, 60)})`, async () => { await adapters.write.deleteNote!(ac, ghlContact, near[0].id); });
      }
    }
    // reactions those runs put on the booking's post (the Showed ✅): the step names the emoji and the post's tag
    const reacts = await many<{ definition: { nodes?: { id?: string; type?: string; react?: string; thread_of?: string }[] }; ran: string[] }>(c, `select v.definition, array(select s.node_id from run_steps s where s.run_id=r.id and s.status='ok') as ran
      from runs r join workflow_versions v on v.workflow_id=r.workflow_id and v.version=r.workflow_version where r.id = any($1::uuid[])`, [runIds]);
    const reacted = new Set<string>();
    for (const v of reacts) for (const n of v.definition.nodes ?? []) {
      if (n.type !== "slack_post" || !n.react || !n.id || !v.ran.includes(n.id) || !n.thread_of?.startsWith("tag:") || !old.appointment) continue;   // only a reaction one of these runs put there
      if (reacted.has(`${n.thread_of}|${n.react}`)) continue; reacted.add(`${n.thread_of}|${n.react}`);
      const tag = n.thread_of.slice(4).replace(/\{\{\s*appointment\.id\s*\}\}/g, old.appointment);
      if (/\{\{/.test(tag)) continue;
      const post = await one<{ channel: string; ts: string }>(c, "select channel, ts from slack_posts where company_id=$1 and tag=$2", [co.id, tag]);
      if (post) add(`take the :${n.react}: off ${old.name}'s booking post`, async () => { const bot = await slackBot(c, co.id); if (!bot) throw new Error("Slack not connected"); await adapters.notifier.unreact(bot.token, post.channel, post.ts, n.react!); });
    }
    // the Slack posts: edited to say so
    const posts = await many<{ channel: string; ts: string; tag: string | null }>(c, "select channel, ts, tag from slack_posts where company_id=$1 and run_id = any($2::uuid[])", [co.id, runIds]);
    if (posts.length && !samePerson) {
      const now = "contact" in target ? `It is ${await nameOf(target.contact)}'s.` : "It is now linked to no one.";
      const text = `~This call was not ${old.name}'s.~ ${now} (${a.why.trim()})`;
      add(`edit ${posts.length} Slack post${posts.length > 1 ? "s" : ""} to: ${text}`, async () => { const bot = await slackBot(c, co.id); if (!bot || !adapters.notifier.update) throw new Error("Slack cannot edit posts here"); for (const p of posts) await adapters.notifier.update(bot.token, p.channel, p.ts, text); });
    }
  }
  const toOut = "contact" in target ? { contact: target.contact, name: await nameOf(target.contact), appointment: target.appointment, by: target.by, ...(target.placed ? { placed: target.placed } : {}) } : { linked: false as const, reason: target.reason };
  // what they made goes first, so nothing is copied back from a record that is about to go
  const ordered = [...steps.filter((x) => x.first), ...steps.filter((x) => !x.first)];
  const workflows = a.backfill === true ? "none" as const : "start" as const;
  if (a.dryRun !== false) return { ok: true, dryRun: true, recording: r.id, from: old, to: toOut, undo: ordered.map((x) => ({ what: x.what })), kept, workflows };

  // put the wrong person back, each part on its own so one failure does not stop the rest
  const undo: Done[] = [];
  for (const x of ordered) {
    try { await x.run(); undo.push({ what: x.what, done: true }); } catch (e) { undo.push({ what: x.what, error: String((e as Error).message).slice(0, 300) }); }
  }
  // then the recording: to no one, or to the right person (their workflow runs)
  await c.query("update recordings set contact_id=null, appointment_id=null, link_status='unlinked', linked_by=null, unlinked_reason=$2 where id=$1", [r.id, "contact" in target ? "moving" : target.reason]);
  let started: number | undefined;
  if ("contact" in target) {
    const l = await linkRecording(c, co.id, r.id, target.contact, { remember: false, appointmentId: target.appointment, by: target.by === "manual" ? "manual" : target.by, placed: target.placed, backfill: a.backfill === true });
    started = l.started;
  }
  await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'recording.relinked','recording',$2,$3,$4)",
    [co.id, r.id, { contact: old?.contact ?? null, appointment: old?.appointment ?? null }, { to: toOut, undo, kept, workflows, why: a.why, by: a.by ?? "operator" }]);
  return { ok: true, dryRun: false, recording: r.id, from: old, to: toOut, undo, kept, workflows, runs_started: started };
}

/**
 * D227: every recording in a window held to the rules as they are now, read only: the ones whose link the rules would not make
 * (linked to someone the rules would not pick, or to no one the rules would link), each with what the rules say and why. The
 * transcript is read again from Fathom when it is no longer held. Fixing one is `relinkRecording` with `to: "rules"`, by name.
 */
export async function checkRecordings(c: PoolClient, adapters: Adapters, companyId: string, from: Date, to: Date): Promise<{ checked: number; differ: { id: string; title: string | null; started_at: string; now: string; rules: string; why?: string }[]; unread: string[] }> {
  const { bindings } = await loadCompany(c, companyId);
  const key = bindings["secret.fathom_api_key"];
  const rows = await many<RecordingRow & { who: string | null }>(c, `select r.*, trim(coalesce(ct.first_name,'')||' '||coalesce(ct.last_name,'')) as who from recordings r left join contacts ct on ct.id=r.contact_id
    where r.company_id=$1 and r.provider<>'ghl' and r.started_at >= $2 and r.started_at < $3 order by r.started_at`, [companyId, from, to]);
  const differ: Awaited<ReturnType<typeof checkRecordings>>["differ"] = [], unread: string[] = [];
  const nameOf = async (id: string) => (await one<{ n: string }>(c, "select trim(coalesce(first_name,'')||' '||coalesce(last_name,'')) as n from contacts where id=$1", [id]))?.n || id;
  for (const r of rows) {
    let transcript = r.transcript;
    if (!transcript?.length && r.provider === "fathom" && key && adapters.recorder) {
      try { transcript = await adapters.recorder.transcript(key, r.external_id); } catch { /* said just below */ }
      if (!transcript?.length) { unread.push(`${r.id} (${r.title ?? "untitled"}): no transcript from Fathom, so it was not checked`); continue; }
    }
    const res = await resolveRecording(c, companyId, { provider: r.provider, externalId: r.external_id, startedAt: r.started_at, recordedBy: { name: r.recorded_by_name ?? undefined, email: r.recorded_by_email ?? undefined }, invitees: r.invitees ?? [], transcript: transcript ?? undefined });
    const nowSays = r.contact_id ? `${r.who || r.contact_id}${r.appointment_id ? "" : " (no booking)"}` : "no one";
    if (res.match) {
      if (res.match.contactId === r.contact_id && (res.match.appointmentId ?? null) === (r.appointment_id ?? null)) continue;
      differ.push({ id: r.id, title: r.title, started_at: r.started_at.toISOString(), now: nowSays, rules: `${await nameOf(res.match.contactId)}${res.match.appointmentId ? res.match.appointmentId === r.appointment_id ? "" : " (another booking)" : " (no booking)"} by ${res.match.by}` });
    } else if (r.contact_id) differ.push({ id: r.id, title: r.title, started_at: r.started_at.toISOString(), now: nowSays, rules: res.internal ? "internal: no one" : "no one: a person's call", why: res.reason });
  }
  return { checked: rows.length, differ, unread };
}
