import type { Definition, Node } from "@/engine/definition";
import { branchTitle, collapsePlumbing, describeNode, durationWords, edgeWords, exitWords, EVENT_LABELS, humanWords, pathWords, predicateWords, waitWords, walkOrder } from "@/engine/describe";
import { exampleContext, nodeExamples, type Example } from "@/engine/example";
import { evaluate } from "@/engine/predicate";
import { SlackPreview } from "./SlackPreview";
import { badge } from "./format";
import type { Pickers } from "./settings-data";

type Step = { node_id: string; status: string; result?: Record<string, unknown>; error?: string | null };
type Row = { label: string; value: React.ReactNode; hover?: React.ReactNode; muted?: boolean };

/**
 * The workflow as a short list a person reads top to bottom: "When: Agreement signed / Add tag: stat-… / Post to Slack: #deals / Complete."
 * Hover a line to see what it produces, rendered as an example (made-up contact, real copy). Read-only: changes come through the chat.
 */
export function Outline({ def: full, company, bindings = {}, pk, steps = [], currentNode }: { def: Definition; company: { name: string; timezone: string }; bindings?: Record<string, string>; pk?: Pickers; steps?: Step[]; currentNode?: string | null }) {
  const def = collapsePlumbing(full);   // "Remember …" steps are plumbing; branches point past them
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const order = walkOrder(def); const index = new Map(order.map((id, i) => [id, i + 1]));
  const out = (id: string) => def.edges.filter((e) => e.from === id);
  const lastStep = new Map<string, Step>(); for (const s of steps) lastStep.set(s.node_id, s);
  const ctx = exampleContext(company, bindings);
  const tz = company.timezone;
  const ref = (v: string | undefined) => (v && pk ? pk.resolve(v) : v?.replace(/[{}\s]/g, "").split("|")[0]);   // "{{crm.pipeline_closer}}" → the bound id, else the setting's name
  const channelName = (v: string) => { const id = ref(v); const ch = pk?.slackChannels?.find((c) => c.id === id); return ch ? `#${ch.name}` : id && !/^slack\./.test(id) ? id : humanWords(pathWords(v)); };
  const userName = (v: string | undefined) => { const id = ref(v); return pk?.users.find((u) => u.ghl_user_id === id)?.name ?? (id ? pathWords(v!) : undefined); };
  const stepRef = (id: string) => { const to = byId.get(id); return <span className="ol-ref">#{index.get(id)} {to ? (to.type === "branch" ? branchTitle(def, id) : describeNode(to).title) : id}</span>; };
  const examples = (n: Node) => nodeExamples(n, ctx, tz);
  const slackBox = (n: Node & { type: "slack_post" | "notify_owner" }) => { const ex = examples(n)[0]?.example; if (!ex) return null; const ch = n.type === "slack_post" ? channelName(n.channel) : "DM to the owner"; return <div className="ol-tip ol-tip-slack"><div className="ol-tip-h">As it would post{ex.exact ? "" : " · template"}</div><SlackPreview name={n.as?.name ?? (bindings["slack.name"] || company.name)} icon={n.as?.icon ?? bindings["slack.icon"]} text={ex.text} channel={ch.replace(/^#/, "")} /><div className="ol-tip-f">Example with a made-up contact. Names, amounts and dates are placeholders.</div></div>; };
  const exampleBox = (list: { label: string; example: Example }[]) => list.length ? <div className="ol-tip">{list.map((x, i) => <div key={i}><div className="ol-tip-h">{x.label}{x.example.exact ? " · example" : " · template"}</div><div className="ol-tip-b">{strip(x.example.text)}</div></div>)}<div className="ol-tip-f">Example with a made-up contact. Names, amounts and dates are placeholders.</div></div> : null;

  const row = (n: Node): Row => {
    switch (n.type) {
      case "trigger": {
        // which of this company's calendars count: the match is evaluated against each calendar's own facts (call type, setter or self), the way the engine does at booking time
        const cals = n.event.startsWith("appointment.") && pk ? pk.calendars.filter((k) => k.active).filter((k) => { try { return !n.match || evaluate(n.match, { appointment: { term: { category: k.category, name: k.term_name }, self_booked: k.self_booked ?? false } }); } catch { return true; } }) : [];
        return { label: "When", value: EVENT_LABELS[n.event] ?? humanWords(n.event), hover: <div className="ol-tip">
          <div className="ol-tip-b">{n.match ? `Only when ${predicateWords(n.match)}.` : `Every time the engine sees “${EVENT_LABELS[n.event] ?? humanWords(n.event)}” for a contact.`}</div>
          {n.event.startsWith("appointment.") && pk ? <><div className="ol-tip-h">Calendars that count</div><div className="ol-tip-b">{cals.length ? cals.map((k) => `${k.name} (${k.term_name}${k.self_booked === true ? ", self-booked" : k.self_booked === false ? ", setter-booked" : ""})`).join(" · ") : "none of this company's calendars match"}</div></> : null}
        </div> };
      }
      case "check": return { label: "Only if", value: predicateWords(n.when), hover: <div className="ol-tip"><div className="ol-tip-b">Otherwise: {exitWords(n.else_exit).toLowerCase()}.</div></div> };
      case "branch": return { label: "Depending on", value: <span>{out(n.id).map((e, i) => <span key={i} className="ol-edge">{edgeWords(e) || "otherwise"} → {stepRef(e.to)}</span>)}</span> };
      case "wait": return { label: "Wait", value: waitWords(n.rule).replace(/^Wait (until )?/, ""), hover: <div className="ol-tip"><div className="ol-tip-b">{describeNode(n).detail}</div></div> };
      case "wait_for_reply": return { label: "Wait for a reply", value: `up to ${durationWords(n.timeout)}`, hover: <div className="ol-tip"><div className="ol-tip-b">{out(n.id).map((e) => `${edgeWords(e)} → #${index.get(e.to)}`).join(" · ") || "continues the minute one arrives"}</div></div> };
      case "send_sms": return { label: "Send text", value: firstLine(examples(n)[0]?.example.text), hover: exampleBox(examples(n)) };
      case "send_email": return { label: "Send email", value: strip(examples(n)[0]?.example.text ?? n.subject), hover: exampleBox(examples(n)) };
      case "slack_post": return { label: n.thread_of ? "Reply in that thread" : "Post to Slack", value: <span>{channelName(n.channel)}{n.as?.name ? <span className="muted"> · as “{n.as.name}”</span> : null}</span>, hover: slackBox(n) };
      case "notify_owner": return { label: "Nudge the owner", value: <span>Slack DM{n.fallback_channel ? <span className="muted"> · else {channelName(n.fallback_channel)}</span> : null}{n.task ? <span className="muted"> · CRM task</span> : null}</span>, hover: slackBox(n) };
      case "send_document": return { label: "Send for signature", value: pathWords(n.template), hover: <div className="ol-tip"><div className="ol-tip-b">{describeNode(n).detail}</div></div> };
      case "set_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { label: t.length > 1 ? "Add tags" : "Add tag", value: t.map((x, i) => <code key={i} className="ol-tag">{x}</code>) }; }
      case "remove_tag": { const t = Array.isArray(n.tag) ? n.tag : [n.tag]; return { label: t.length > 1 ? "Remove tags" : "Remove tag", value: t.map((x, i) => <code key={i} className="ol-tag">{x}</code>) }; }
      case "note": return { label: "Add internal note", value: `“${firstLine(examples(n)[0]?.example.text)}”`, hover: exampleBox(examples(n)) };
      case "pipeline_card": { const p = pk?.pipelineName(ref(n.pipeline) ?? "") ?? pathWords(n.pipeline); const s = n.stage ? pk?.stageName(ref(n.stage) ?? "") ?? pathWords(n.stage) : null;
        return { label: n.stage ? (n.if_missing === "skip" ? "Move card" : "Create or move card") : "Update card", value: <span>{p}{s ? ` › ${s}` : ""}{n.status ? <span className="muted"> · mark {n.status}</span> : null}{n.assign_to ? <span className="muted"> · owner {userName(n.assign_to)}</span> : null}{n.if_missing === "skip" ? <span className="muted"> · only if it exists</span> : null}</span>, hover: n.fields.length || n.name ? <div className="ol-tip">{n.name ? <div className="ol-tip-b">Card name: {examples(n)[0]?.example.text}</div> : null}{n.fields.length ? <div className="ol-tip-b">Sets {n.fields.map((f) => `${pathWords(f.id)} = ${strip(f.value)}`).join("; ")}</div> : null}</div> : undefined }; }
      case "update_contact": return { label: "Update contact", value: describeNode(n).detail ?? "fields" };
      case "update_appointment": return { label: "Update appointment", value: describeNode(n).title.replace(/^Mark appointment /, "") };
      case "update_opportunity": return { label: "Update opportunity", value: describeNode(n).title.replace(/^Update opportunity: /, "") };
      case "crm_record": return { label: "Write record", value: humanWords(n.object.replace(/^custom_objects\./, "")), hover: <div className="ol-tip"><div className="ol-tip-b">Keyed by {pathWords(n.key)}. Fields: {Object.keys(n.properties).map(humanWords).join(", ")}.</div></div> };
      case "record_outcome": return { label: "Mark appointment", value: humanWords(n.outcome) + (n.call_outcome ? ` · call ${humanWords(n.call_outcome)}` : "") };
      case "create_task": return { label: "Create task", value: <span>“{examples(n)[0]?.example.text}”<span className="muted"> · for {userName(n.assign_to) ?? "the team"} · due in {durationWords(n.due)}</span></span>, hover: exampleBox(examples(n)) };
      case "classify": return { label: "AI reads the reply", value: `${humanWords(n.domain)} options`, hover: <div className="ol-tip"><div className="ol-tip-b">{describeNode(n).detail}</div></div> };
      case "analyze": return { label: n.format === "text" ? "AI writes" : "AI reads", value: describeNode(n).title.replace(/^AI (reads|writes) /, ""), hover: <div className="ol-tip"><div className="ol-tip-b">{describeNode(n).detail}</div></div> };
      case "set_var": return { label: "Remember", value: `${humanWords(n.key)}${typeof n.value === "string" && /\{\{/.test(n.value) ? "" : ` = ${typeof n.value === "string" ? n.value : JSON.stringify(n.value)}`}`, hover: exampleBox(examples(n)), muted: true };
      case "start_workflow": return { label: "Hand off to", value: humanWords(n.workflow) };
      case "pause_runs": return { label: "Pause", value: `the ${n.scope === "contact" ? "contact's" : "appointment's"} other workflows` };
      case "exit": return { label: n.reason.startsWith("not_") || /^(no_|handed|escalated)/.test(n.reason) ? "Stop" : "Complete.", value: exitWords(n.reason).replace(/^(Done|Stop): /, "").replace(/^Done$/, "") };
    }
  };

  // "done" is implied; a stop with a reason still shows. set_var is plumbing (assembling a line of copy), not a step a person needs to read: Advanced has the definition
  const shown = order.filter((id) => { const n = byId.get(id)!; return !(n.type === "exit" && row(n).label === "Complete."); });
  return <ol className="outline">{shown.map((id) => {
    const n = byId.get(id)!; const r = row(n); const st = lastStep.get(id); const here = !st && currentNode === id;
    const after = out(id).filter((e) => n.type !== "branch" && n.type !== "wait_for_reply" && n.type !== "exit" && (e.label || e.when || e.else));   // a labelled edge off a non-branch node is a fork worth naming
    return <li key={id} tabIndex={r.hover ? 0 : undefined} className={`ol-row ${r.hover ? "has-tip" : ""} ${st ? `st-${st.status}` : here ? "st-here" : ""} ${r.muted ? "ol-muted" : ""}`}>
      <span className="ol-n">{index.get(id)}</span>
      <span className="ol-label">{r.label}{n.type === "exit" ? "" : ":"}</span>
      <span className="ol-value">{r.value}{after.length ? <span className="ol-forks">{after.map((e, i) => <span key={i} className="ol-edge">{edgeWords(e)} → {stepRef(e.to)}</span>)}</span> : null}</span>
      {st ? <span className={badge(stepLabel(st).cls)}>{stepLabel(st).text}</span> : null}{here ? <span className="badge b-waiting">here now</span> : null}
      {st?.error ? <div className="ol-err">{st.error}</div> : null}
      {r.hover}
    </li>; })}</ol>;
}

/** What a step's status means to a person: a shadow write is "shadow", a skip with nothing to do is "nothing to do", a skip because something is missing is "blocked". */
export function stepLabel(st: { status: string; result?: Record<string, unknown> }): { text: string; cls: string } {
  const r = st.result ?? {};
  if (st.status === "ok" && r.shadow) return { text: "shadow", cls: "shadow" };
  if (st.status === "skipped") return r.kind === "blocked" ? { text: "blocked", cls: "stale" } : r.kind === "noop" ? { text: "nothing to do", cls: "skipped" } : { text: "skipped", cls: "skipped" };
  return { text: st.status, cls: st.status };
}
const strip = (s: string | undefined) => (s ?? "").replace(/<[^|>]+\|([^>]+)>/g, "$1").replace(/<\/?(p|br|div|ul|li|strong|em|b|i|a|span|h\d)[^>]*>/gi, " ").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
const firstLine = (s: string | undefined) => { const t = strip(s).split("\n").map((x) => x.trim()).filter(Boolean)[0] ?? ""; return t.length > 90 ? `${t.slice(0, 89)}…` : t; };
