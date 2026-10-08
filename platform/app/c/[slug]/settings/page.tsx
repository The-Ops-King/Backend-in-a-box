import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSettings } from "@/ui/settings-data";
import { ensureSchedules } from "@/engine/reports";
import { SaveButton } from "@/ui/SaveButton";
import { asOperator } from "@/db/client";
import { ReadinessCard } from "@/ui/Readiness";
import { groupOf, type SettingRow } from "@/engine/settings";
import { saveCompanyAction, saveBindingsAction, testGhlAction, setBookingSourceAction, saveCalendarAction, saveSlackAction, saveCallTypesAction, describeConfigAction, applyProposalAction, discardProposalAction, saveReportScheduleAction, runReportNowAction } from "@/ui/settings-actions";
import type { Operation } from "@/engine/describe-config";
export const dynamic = "force-dynamic";

type Opt = { value: string; label: string };
const humanKey = (k: string) => k.replace(/^(crm\.(pipeline_|stage_|field_contact_|field_opportunity_|assoc_)?|calendar\.|slack\.channel\.|prompt\.|secret\.|calendly\.|booking\.)/, "").replace(/_/g, " ");

function Pick({ row, options, placeholder }: { row: SettingRow; options?: Opt[]; placeholder?: string }) {
  const cur = row.value ?? "";
  const known = options?.some((o) => o.value === cur);
  return <tr className={row.required && !row.set ? "missing" : ""}>
    <td><strong>{humanKey(row.key)}</strong><div className="mono muted" style={{ fontSize: 11.5 }}>{row.key}{row.usedBy.length ? ` · ${row.usedBy.join(", ")}` : ""}</div></td>
    <td>{options && options.length ? <select name={`b:${row.key}`} defaultValue={cur}><option value="">{row.set ? "— keep as is —" : "— not set —"}</option>{!known && cur ? <option value={cur}>{cur} (not in the list)</option> : null}{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      : <input name={`b:${row.key}`} type="text" defaultValue={cur} placeholder={placeholder ?? (row.set ? "" : "not set")} />}<input type="hidden" name={`k:${row.key}`} value={row.kind} /></td>
    <td>{row.set ? <span className="badge b-live">set</span> : row.required ? <span className="badge b-failed">missing</span> : <span className="badge b-type">optional</span>}</td>
  </tr>;
}
function Secret({ row, label, hint }: { row: SettingRow; label: string; hint?: string }) {
  return <tr className={row.required && !row.set ? "missing" : ""}>
    <td><strong>{label}</strong><div className="mono muted" style={{ fontSize: 11.5 }}>{row.key}</div>{hint ? <div className="muted" style={{ fontSize: 12.5 }}>{hint}</div> : null}</td>
    <td><div className="secret-row"><input name={`b:${row.key}`} type="password" autoComplete="off" placeholder={row.set ? "paste to replace" : "paste"} /><input type="hidden" name={`k:${row.key}`} value="secret" />{row.set ? <label className="muted" style={{ fontSize: 12.5 }}><input type="checkbox" name={`clear:${row.key}`} /> clear</label> : null}</div></td>
    <td>{row.set ? <span className="badge b-live">{row.masked}</span> : row.required ? <span className="badge b-failed">missing</span> : <span className="badge b-type">not set</span>}</td>
  </tr>;
}
function opWords(op: Operation, d: { liveCalendars: { id: string; name: string }[]; users: { ghl_user_id: string | null; name: string }[] }): string {
  const cal = (id: string) => d.liveCalendars.find((c) => c.id === id)?.name ?? id;
  switch (op.op) {
    case "map_calendar": return `"${cal(op.calendar_id)}" is a ${op.call_type_name ?? op.call_type.replace(/_/g, " ")} call, ${op.booking === "self" ? "always self-booked" : op.booking === "setter" ? "always setter-booked" : op.booking === "question" ? "setter decided by the booking question" : "company rule"}${op.questions && Object.keys(op.questions).length ? `; questions: ${Object.entries(op.questions).map(([k, v]) => `${k} = "${v}"`).join(", ")}` : ""}${op.active === false ? "; inactive" : ""}`;
    case "set_setter_rule": return `company setter rule → ${op.rule}`;
    case "set_default_closer": return `default closer → ${d.users.find((u) => u.ghl_user_id === op.user_id)?.name ?? op.user_id}`;
    case "set_calendar_role": return `"${cal(op.calendar_id)}" is the ${op.role === "closer_call" ? "closer call" : "booking link we send"}`;
    case "add_call_type": return `new call type "${op.name}" (${op.category.replace(/_/g, " ")})`;
  }
}
/** Every zone the runtime knows, America first: the ones a US sales team picks are at the top, the rest alphabetical. */
const TIMEZONES = (() => { const all = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); const us = all.filter((z) => z.startsWith("America/") || z === "Pacific/Honolulu"); return [...us, ...all.filter((z) => !us.includes(z))]; })();
const Hidden = ({ slug, id, section }: { slug: string; id: string; section: string }) => <><input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={id} /><input type="hidden" name="section" value={section} /></>;

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ note?: string; error?: string }> }) {
  const { slug } = await params; const sp = await searchParams; const d = await loadSettings(slug); if (!d) notFound();
  const schedules = await asOperator((c) => ensureSchedules(c, d.company.id));
  const { company: co, rows, byKey, catalog } = d;
  const row = (k: string) => byKey.get(k) ?? { key: k, kind: k.startsWith("secret.") ? "secret" : "id", required: false, usedBy: [], value: null, masked: null, set: false } as SettingRow;
  const group = (g: ReturnType<typeof groupOf>) => rows.filter((r) => groupOf(r.key) === g);
  const stageOpts: Opt[] = (catalog?.pipelines ?? []).flatMap((p) => p.stages.map((s) => ({ value: s.id, label: `${p.name} › ${s.name}` })));
  const pipeOpts: Opt[] = (catalog?.pipelines ?? []).map((p) => ({ value: p.id, label: p.name }));
  const cfOpts: Opt[] = (catalog?.contactFields ?? []).map((f) => ({ value: f.id, label: `${f.name}${f.type ? ` (${f.type.toLowerCase()})` : ""}` }));
  const ofOpts: Opt[] = (catalog?.opportunityFields ?? []).map((f) => ({ value: f.id, label: `${f.name}${f.type ? ` (${f.type.toLowerCase()})` : ""}` }));
  const assocOpts: Opt[] = (catalog?.associations ?? []).map((a) => ({ value: a.id, label: a.label }));
  const userOpts: Opt[] = d.users.filter((u) => u.ghl_user_id).map((u) => ({ value: u.ghl_user_id!, label: `${u.name} (${u.email})` }));
  const calOpts: Opt[] = d.calendars.map((c) => ({ value: c.external_id, label: `${c.name}${c.active ? "" : " (inactive)"}` }));
  const mapped = new Map(d.calendars.map((c) => [c.external_id, c]));
  const unmapped = d.liveCalendars.filter((l) => !mapped.has(l.id));
  const questionsText = (q?: Record<string, string>) => Object.entries(q ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n");
  const ghlRow = row("secret.ghl_pit"), locRow = row("crm.location_id");
  return (<>
    <p className="sub"><Link href="/">Companies</Link> / <Link href={`/c/${slug}`}>{co.name}</Link> / Settings</p>
    <h1>Settings</h1>
    <p className="sub">Everything this company's workflows need, in one place. Lists come live from the CRM and the booking source where a key exists; anything else is pasted. Secrets are stored encrypted and never shown again.</p>
    {sp.note ? <div className="card ready" style={{ marginBottom: 10 }}><strong>{sp.note}</strong></div> : null}
    {sp.error ? <div className="card ready ready-no" style={{ marginBottom: 10 }}><strong>Not saved.</strong> {sp.error}</div> : null}
    <ReadinessCard r={d.readiness} />
    <nav className="sub" style={{ margin: "10px 0 18px" }}>{["describe", "company", "connections", "booking", "calltypes", "calendars", "crm", "slack", "prompts", "inbound"].map((s) => <a key={s} href={`#${s}`} style={{ marginRight: 14 }}>{s[0].toUpperCase() + s.slice(1)}</a>)}</nav>

    <h2 id="describe">Tell it how things work</h2>
    <form action={describeConfigAction} className="form card settings"><Hidden slug={slug} id={co.id} section="describe" />
      <p className="sub">Write it the way you'd tell a new ops hire. The engine already sees every calendar with its questions and hosts, the roster, the pipelines. It proposes the settings it can set and asks about what it can't. Nothing is applied until you say so.</p>
      <textarea name="text" rows={5} defaultValue={d.proposal?.text ?? ""} placeholder={"The '- S' calendar is for setter bookings and the Setter question says who set it. The round-robin strategy call is self-booked. James takes the closing calls. The 30 minute meeting is internal, ignore it."} />
      <SaveButton>Read it</SaveButton>
    </form>
    {d.proposal ? <div className="card settings ready">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}><strong>Proposal</strong><span className="muted">from what you wrote</span></div>
      <p>{d.proposal.proposal.summary}</p>
      {d.proposal.proposal.operations.length ? <ul className="ready-list">{d.proposal.proposal.operations.map((op, i) => <li key={i} className="warning"><span className="badge b-type">{op.op.replace(/_/g, " ")}</span> {opWords(op, d)} <span className="muted">— {op.why}</span></li>)}</ul> : <div className="muted">Nothing to change.</div>}
      {d.proposal.proposal.questions.length ? <><div style={{ marginTop: 10 }}><strong>It still needs to know:</strong></div><ul className="ready-list">{d.proposal.proposal.questions.map((q, i) => <li key={i} className="blocker"><span className="badge b-failed">?</span> {q}</li>)}</ul><div className="muted" style={{ fontSize: 13 }}>Answer in the box above and read it again; what is already settled stays in the proposal.</div></> : null}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <form action={applyProposalAction}><Hidden slug={slug} id={co.id} section="describe" /><button className="btn btn-on" type="submit" disabled={!d.proposal.proposal.operations.length}>Apply these</button></form>
        <form action={discardProposalAction}><Hidden slug={slug} id={co.id} section="describe" /><button className="btn btn-off" type="submit">Discard</button></form>
      </div>
    </div> : null}

    <h2 id="company">Company</h2>
    <form action={saveCompanyAction} className="form card settings"><Hidden slug={slug} id={co.id} section="company" />
      <div className="grid g2">
        <label>Name<input name="name" type="text" defaultValue={co.name} required /></label>
        <label>Time zone<select name="timezone" defaultValue={co.timezone} required>{TIMEZONES.includes(co.timezone) ? null : <option value={co.timezone}>{co.timezone}</option>}{TIMEZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</select></label>
        <label>Send window opens<input name="send_window_start" type="time" defaultValue={co.send_window_start.slice(0, 5)} /></label>
        <label>Send window closes<input name="send_window_end" type="time" defaultValue={co.send_window_end.slice(0, 5)} /></label>
        <label>Program price (contract value default)<input name="contract_value_default" type="number" step="0.01" defaultValue={co.contract_value_default ?? ""} /></label>
        <label>A lead counts as reached when a connected call lasts at least (seconds)<input name="reached_seconds" type="number" min={1} defaultValue={co.reached_seconds ?? 60} /></label>
        <div><label><input type="checkbox" name="sms_enabled" defaultChecked={co.sms_enabled} /> SMS enabled (off when the sub-account has no number)</label>
          <label><input type="checkbox" name="quiet_allow_transactional" defaultChecked={co.quiet_allow_transactional} /> Let automated receipts ("you're booked") go out in dark hours. Human-sounding messages always wait.</label></div>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>Mode is {co.mode}; switch it on the company page.</div>
      <SaveButton>Save company</SaveButton>
    </form>

    <h2 id="connections">Connections</h2>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="connections" />
      <h3>GoHighLevel</h3>
      <table className="kv-table"><tbody>
        <Pick row={locRow} placeholder="location id" />
        <Secret row={ghlRow} label="Private Integration Token" hint="Read-only is enough for shadow. Live needs contacts.write, opportunities.write, objects/record.write." />
        <Secret row={row("secret.anthropic_key")} label="Anthropic API key" hint="For the AI steps (call reviews). Per company; the server key is the fallback." />
        <Secret row={row("secret.whop_api_key")} label="Whop API key" hint="Lets the engine create its own Whop webhook and backfill payment history. Needs payment:basic:read and developer:manage_webhook." />
        <Secret row={row("secret.whop_webhook")} label="Whop webhook signing secret" hint="Set when the engine creates the webhook from the API key, or paste one from a webhook you made in Whop." />
        <Secret row={row("secret.fathom_api_key")} label="Fathom API key" hint="Saving it registers the engine's own Fathom webhook automatically." />
        <Secret row={row("secret.fathom_webhook")} label="Fathom webhook secret" hint="Set automatically from the API key; paste one only if you made the webhook in Fathom yourself." />
      </tbody></table>
      <SaveButton>Save connections</SaveButton>
    </form>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0 18px" }}>
      <form action={testGhlAction}><Hidden slug={slug} id={co.id} section="connections" /><button className="btn" type="submit">Test GHL and refresh the roster</button></form>
    </div>
    {catalog?.errors.length ? <div className="card ready ready-no"><strong>Some GHL lists did not load</strong><ul className="ready-list">{catalog.errors.map((e) => <li key={e} className="warning">{e}</li>)}</ul></div> : null}

    <h2 id="booking">Booking source</h2>
    <form action={setBookingSourceAction} className="form card settings"><Hidden slug={slug} id={co.id} section="booking" />
      <p className="sub">Where appointments live. Currently <strong>{d.bookingSource === "calendly" ? "Calendly" : "GHL calendars"}</strong>. Every host's calendars are pulled; you choose what each one is below.</p>
      <label><input type="radio" name="source" value="ghl" defaultChecked={d.bookingSource === "ghl"} /> GHL calendars (same PIT)</label>
      <label><input type="radio" name="source" value="calendly" defaultChecked={d.bookingSource === "calendly"} /> Calendly</label>
      <div className="grid g2" style={{ marginTop: 8 }}>
        <label>Calendly token (read)<input name="token" type="password" placeholder={row("secret.calendly_token").set ? `kept: ${row("secret.calendly_token").masked}` : "paste"} /></label>
        <label>Default phone question<input name="phoneQuestion" type="text" defaultValue={row("calendly.phone_question").value ?? ""} placeholder="Phone Number" /></label>
        <label>Default setter question<input name="setterQuestion" type="text" defaultValue={row("calendly.setter_question").value ?? ""} placeholder="Who set this call?" /></label>
      </div>
      <SaveButton>Save booking source</SaveButton>
    </form>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="booking" />
      <table className="kv-table"><tbody>
        <tr><td><strong>Company setter rule</strong><div className="mono muted" style={{ fontSize: 11.5 }}>booking.setter_rule · a calendar's own rule wins</div></td>
          <td><select name="b:booking.setter_rule" defaultValue={row("booking.setter_rule").value ?? ""}><option value="">— keep —</option><option value="calendar">calendar: the calendar decides (separate setter calendar)</option><option value="question">question: a named setter means setter-booked</option><option value="either">either: setter calendar or a named setter</option></select><input type="hidden" name="k:booking.setter_rule" value="text" /></td><td>{row("booking.setter_rule").value ?? "calendar (default)"}</td></tr>
        <Pick row={row("crm.default_closer")} options={userOpts} />
      </tbody></table>
      <SaveButton>Save booking rules</SaveButton>
    </form>

    <h2 id="calltypes">Call types</h2>
    <form action={saveCallTypesAction} className="form card settings"><Hidden slug={slug} id={co.id} section="calltypes" />
      <p className="sub">Your words for the kinds of calls (triage, demo, strategy call…), each tied to one of the engine's four categories so reports stay comparable. Templates trigger on the category.</p>
      <table className="kv-table"><tbody>
        {d.terms.map((t) => <tr key={t.id}><td><input type="text" name={`term:${t.id}:name`} defaultValue={t.name} /></td><td><select name={`term:${t.id}:category`} defaultValue={t.category}><option value="first_call">first call (triage, discovery)</option><option value="qualifying">qualifying (demo, qualification)</option><option value="closing">closing (the sales call)</option><option value="follow_up">follow-up</option></select></td><td><label><input type="checkbox" name={`term:${t.id}:active`} defaultChecked={t.active} /> active</label>{t.in_use ? <div className="muted" style={{ fontSize: 12 }}>{t.in_use} calendar{t.in_use > 1 ? "s" : ""}</div> : null}</td></tr>)}
        <tr><td><input type="text" name="new_name" placeholder="add one: e.g. Triage" /></td><td><select name="new_category" defaultValue=""><option value="">— category —</option><option value="first_call">first call</option><option value="qualifying">qualifying</option><option value="closing">closing</option><option value="follow_up">follow-up</option></select></td><td></td></tr>
      </tbody></table>
      <SaveButton>Save call types</SaveButton>
    </form>

    <h2 id="calendars">Calendars</h2>
    <p className="sub">Each calendar: the call type it books, how setter-vs-self is decided on it, and which booking questions mean what (one per line, <code>name = question text as it appears</code>; <code>setter</code> and <code>phone</code> are special, anything else becomes <code>appointment.answers.name</code>).{d.liveCalendarsError ? <span className="bad"> Could not list calendars from the source: {d.liveCalendarsError}</span> : null}</p>
    {[...d.calendars.map((c) => { const l = d.liveCalendars.find((x) => x.id === c.external_id); return { id: c.external_id, name: c.name, url: c.booking_url ?? undefined, note: l?.note, hosts: l?.hosts, pooling: l?.pooling, questions: l?.questions, cur: c }; }), ...unmapped.map((l) => ({ id: l.id, name: l.name, url: l.bookingUrl, note: l.note, hosts: l.hosts, pooling: l.pooling, questions: l.questions, cur: undefined }))].map((c) => (
      <form key={c.id} action={saveCalendarAction} className="form card settings calendar"><Hidden slug={slug} id={co.id} section="calendars" />
        <input type="hidden" name="externalId" value={c.id} /><input type="hidden" name="name" value={c.name} /><input type="hidden" name="bookingUrl" value={c.url ?? ""} />
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}><strong>{c.name}</strong><span className="mono muted" style={{ fontSize: 11.5 }}>{c.id}</span>{c.hosts?.length ? <span className="muted">· {c.hosts.map((h) => h.name || h.email).join(", ")}</span> : null}{c.pooling ? <span className="badge b-type">{c.pooling.replace(/_/g, " ")}</span> : null}{c.note ? <span className="muted">· note: {c.note}</span> : null}{c.cur ? <span className={`badge ${c.cur.active ? "b-live" : "b-type"}`}>{c.cur.active ? "active" : "inactive"}</span> : <span className="badge b-shadow">not mapped</span>}</div>
        <div className="grid g4" style={{ marginTop: 8 }}>
          <label>Call type<select name="term" defaultValue={c.cur?.appointment_term ?? ""} required><option value="">—</option>{d.terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>Setter or self?<select name="booking" defaultValue={c.cur?.config.booking ?? (c.cur?.self_booked === true ? "self" : c.cur?.self_booked === false ? "setter" : "company")}><option value="company">company rule</option><option value="self">always self-booked</option><option value="setter">always setter-booked</option><option value="question">decided by the setter question</option></select></label>
          <label>Role<select name="role" defaultValue={row("calendar.closer_call").value === c.id ? "closer_call" : row("calendar.booking").value === c.id ? "booking" : ""}><option value="">—</option><option value="closer_call">the closer call (calendar.closer_call)</option><option value="booking">the booking link we send (calendar.booking)</option></select></label>
          <label>Active<select name="active" defaultValue={c.cur && !c.cur.active ? "off" : "on"}><option value="on">yes, poll it</option><option value="off">no</option></select></label>
        </div>
        {c.questions?.length ? <div style={{ marginTop: 8 }}><div className="muted" style={{ fontSize: 12.5, letterSpacing: ".04em", textTransform: "uppercase" }}>This calendar's booking questions · what each one means to the engine</div>
          <table className="kv-table"><tbody>{c.questions.map((q, i) => { const used = Object.entries(c.cur?.config.questions ?? {}).find(([, text]) => text.trim().toLowerCase() === q.name.trim().toLowerCase() || q.name.trim().toLowerCase().startsWith(text.trim().toLowerCase()))?.[0] ?? (q.type === "phone_number" ? "phone" : "");
            return <tr key={i}><td><input type="hidden" name={`q:${i}`} value={q.name} />{q.name}<div className="muted" style={{ fontSize: 12 }}>{q.type ?? "text"}{q.required ? " · required" : ""}{q.choices ? ` · ${q.choices.join(" / ")}` : ""}</div></td><td><input type="text" name={`use:${i}`} defaultValue={used} placeholder="ignore" list="use-as" /></td></tr>; })}</tbody></table>
          <datalist id="use-as"><option value="setter" /><option value="phone" /><option value="email" /><option value="noticing_for" /><option value="hair_loss" /><option value="budget" /><option value="source" /></datalist>
          <div className="muted" style={{ fontSize: 12.5 }}>Type a name to use the answer: <code>setter</code> and <code>phone</code> are special; anything else is readable in messages as <code>appointment.answers.name</code>. Blank ignores it.</div></div>
          : <label>Questions (name = question text, one per line)<textarea name="questions" rows={2} defaultValue={questionsText(c.cur?.config.questions)} placeholder={"setter = Who set this call for you\nphone = Best number"} /></label>}
        <SaveButton>{c.cur ? "Save calendar" : "Map this calendar"}</SaveButton>
      </form>))}
    {!d.calendars.length && !unmapped.length ? <div className="empty">No calendars yet. Connect the booking source above.</div> : null}

    <h2 id="crm">CRM ids the workflows use</h2>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="crm" />
      {(["pipelines", "stages", "contact_fields", "opportunity_fields", "associations", "calendars", "other"] as const).map((g) => { const rs = group(g).filter((r) => !["crm.location_id", "crm.default_closer"].includes(r.key)); if (!rs.length) return null;
        const opts = g === "pipelines" ? pipeOpts : g === "stages" ? stageOpts : g === "contact_fields" ? cfOpts : g === "opportunity_fields" ? ofOpts : g === "associations" ? assocOpts : g === "calendars" ? calOpts : undefined;
        return <div key={g}><h3>{g.replace(/_/g, " ")}</h3><table className="kv-table"><tbody>{rs.map((r) => <Pick key={r.key} row={r} options={opts && opts.length ? opts : undefined} />)}</tbody></table></div>; })}
      {!catalog ? <div className="muted">Connect GHL above and the pipelines, stages, fields and associations become drop-downs.</div> : null}
      <SaveButton>Save CRM ids</SaveButton>
    </form>

    <h2 id="slack">Slack</h2>
    <form action={saveSlackAction} className="form card settings"><Hidden slug={slug} id={co.id} section="slack" />
      <p className="sub">{d.slack ? <>Connected to workspace <span className="mono">{d.slack.team_id}</span>.</> : "Not connected: every Slack post is recorded but never posted."} A bot token (xoxb-…) from a Slack app with chat:write; paste <code>disconnect</code> to remove it.</p>
      <div style={{ display: "flex", gap: 8 }}><input name="botToken" type="password" placeholder="xoxb-…" style={{ minWidth: 320 }} /><SaveButton>{d.slack ? "Replace token" : "Connect Slack"}</SaveButton></div>
    </form>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="slack" />
      <table className="kv-table"><tbody>{group("slack").map((r) => <Pick key={r.key} row={r} options={d.slackChannels?.map((ch) => ({ value: ch.id, label: `#${ch.name}` }))} placeholder="C0123ABCDEF (channel id)" />)}</tbody></table>
      {d.slack && !d.slackChannels ? <div className="muted" style={{ fontSize: 13 }}>The bot cannot list channels (needs channels:read and groups:read); paste channel ids.</div> : null}
      <SaveButton>Save channels</SaveButton>
    </form>

    <h2 id="prompts">Prompts</h2>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="prompts" />
      <p className="sub">What the AI is told before it reads a transcript. Each ends with the JSON shape the workflow expects; keep that part.</p>
      {group("prompts").map((r) => <label key={r.key}><strong>{humanKey(r.key)}</strong> <span className="mono muted" style={{ fontSize: 11.5 }}>{r.key}{r.usedBy.length ? ` · ${r.usedBy.join(", ")}` : ""}</span><textarea name={`b:${r.key}`} rows={8} defaultValue={r.value ?? ""} /><input type="hidden" name={`k:${r.key}`} value="text" /></label>)}
      {group("prompts").length ? <SaveButton>Save prompts</SaveButton> : <div className="muted">No installed workflow uses a prompt.</div>}
    </form>

    <h2 id="reports">Wrap-ups</h2>
    <p className="sub">What happened today, last week, last month — computed from the engine's own ledger (D29) and posted to Slack on this company's clock. Nothing here is fixed in code: time, day, channel, breakdowns. <Link href={`/c/${slug}/reports`}>Read past wrap-ups</Link>.</p>
    {schedules.map((r) => <form key={r.kind} action={saveReportScheduleAction} className="form card settings"><Hidden slug={slug} id={co.id} section="reports" /><input type="hidden" name="kind" value={r.kind} />
      <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}><strong style={{ textTransform: "capitalize" }}>{r.kind}</strong><label><input type="checkbox" name="enabled" defaultChecked={r.enabled} /> enabled</label>{r.last_period_start ? <span className="muted" style={{ fontSize: 12 }}>last sent for {r.last_period_start}</span> : <span className="muted" style={{ fontSize: 12 }}>never sent</span>}</div>
      <div className="grid g2" style={{ marginTop: 8 }}>
        <label>Send at ({co.timezone})<input type="time" name="at_time" defaultValue={r.at_time} /></label>
        {r.kind === "weekly" ? <label>On<select name="weekday" defaultValue={r.weekday}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((dn, i) => <option key={dn} value={i + 1}>{dn}</option>)}</select></label> : null}
        {r.kind === "monthly" ? <label>On day<input type="number" name="day_of_month" min={1} max={28} defaultValue={r.day_of_month} /></label> : null}
        <label>Slack channel{d.slackChannels ? <select name="channel" defaultValue={r.channel ?? ""}><option value="">— the reports channel binding —</option>{d.slackChannels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}</select> : <input type="text" name="channel" defaultValue={r.channel ?? ""} placeholder="C0123ABCDEF, or leave blank for slack.channel.reports" />}</label>
        <div><label><input type="checkbox" name="breakdown:setter" defaultChecked={r.breakdowns.includes("setter")} /> per setter</label> <label><input type="checkbox" name="breakdown:closer" defaultChecked={r.breakdowns.includes("closer")} /> per closer</label> <label><input type="checkbox" name="section:what_they_said" defaultChecked={r.sections.what_they_said !== false} /> what they said (booking-form answers)</label></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}><SaveButton>Save</SaveButton><button className="btn" type="submit" formAction={runReportNowAction}>Generate now</button></div>
    </form>)}

    <h2 id="inbound">Inbound doors</h2>
    <div className="card settings">
      <table className="kv-table"><tbody>
        <tr><td><strong>Whop webhook</strong></td><td className="mono">{d.inbound.whop}</td><td>needs the signing secret above</td></tr>
        <tr><td><strong>Fathom webhook</strong></td><td className="mono">{d.inbound.fathom}</td><td>{d.inbound.fathomWebhookId ? `registered (${d.inbound.fathomWebhookId})` : "set automatically when the Fathom API key is saved; or make one in Fathom and paste its secret"}</td></tr>
        <tr><td><strong>Zapier → payment</strong></td><td className="mono">{d.inbound.zapierPayment}</td><td>header x-engine-secret</td></tr>
        <tr><td><strong>Zapier → recording</strong></td><td className="mono">{d.inbound.zapierRecording}</td><td>header x-engine-secret</td></tr>
        <tr><td><strong>Zapier secret</strong></td><td className="mono">{d.inbound.secret ?? "— generated on first install —"}</td><td>same for both Zapier doors</td></tr>
      </tbody></table>
    </div>
  </>);
}
