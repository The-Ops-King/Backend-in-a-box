import Link from "next/link";
import { notFound } from "next/navigation";
import { loadSettings } from "@/ui/settings-data";
import { ReadinessCard } from "@/ui/Readiness";
import { groupOf, type SettingRow } from "@/engine/settings";
import { saveCompanyAction, saveBindingsAction, testGhlAction, setBookingSourceAction, saveCalendarAction, registerFathomAction, saveSlackAction } from "@/ui/settings-actions";
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
    <td><input name={`b:${row.key}`} type="password" autoComplete="off" placeholder={row.set ? "paste to replace" : "paste"} /><input type="hidden" name={`k:${row.key}`} value="secret" />{row.set ? <label className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}><input type="checkbox" name={`clear:${row.key}`} /> clear</label> : null}</td>
    <td>{row.set ? <span className="badge b-live">{row.masked}</span> : row.required ? <span className="badge b-failed">missing</span> : <span className="badge b-type">not set</span>}</td>
  </tr>;
}
const Hidden = ({ slug, id, section }: { slug: string; id: string; section: string }) => <><input type="hidden" name="slug" value={slug} /><input type="hidden" name="companyId" value={id} /><input type="hidden" name="section" value={section} /></>;

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ note?: string; error?: string }> }) {
  const { slug } = await params; const sp = await searchParams; const d = await loadSettings(slug); if (!d) notFound();
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
    <nav className="sub" style={{ margin: "10px 0 18px" }}>{["company", "connections", "booking", "calendars", "crm", "slack", "prompts", "inbound"].map((s) => <a key={s} href={`#${s}`} style={{ marginRight: 14 }}>{s[0].toUpperCase() + s.slice(1)}</a>)}</nav>

    <h2 id="company">Company</h2>
    <form action={saveCompanyAction} className="form card settings"><Hidden slug={slug} id={co.id} section="company" />
      <div className="grid g2">
        <label>Name<input name="name" type="text" defaultValue={co.name} required /></label>
        <label>Time zone (IANA)<input name="timezone" type="text" defaultValue={co.timezone} required /></label>
        <label>Send window opens<input name="send_window_start" type="time" defaultValue={co.send_window_start.slice(0, 5)} /></label>
        <label>Send window closes<input name="send_window_end" type="time" defaultValue={co.send_window_end.slice(0, 5)} /></label>
        <label>Program price (contract value default)<input name="contract_value_default" type="number" step="0.01" defaultValue={co.contract_value_default ?? ""} /></label>
        <div><label><input type="checkbox" name="sms_enabled" defaultChecked={co.sms_enabled} /> SMS enabled (off when the sub-account has no number)</label>
          <label><input type="checkbox" name="quiet_allow_transactional" defaultChecked={co.quiet_allow_transactional} /> Let automated receipts ("you're booked") go out in dark hours. Human-sounding messages always wait.</label></div>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>Mode is {co.mode}; switch it on the company page.</div>
      <button className="btn btn-on" type="submit">Save company</button>
    </form>

    <h2 id="connections">Connections</h2>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="connections" />
      <h3>GoHighLevel</h3>
      <table className="kv-table"><tbody>
        <Pick row={locRow} placeholder="location id" />
        <Secret row={ghlRow} label="Private Integration Token" hint="Read-only is enough for shadow. Live needs contacts.write, opportunities.write, objects/record.write." />
        <Secret row={row("secret.anthropic_key")} label="Anthropic API key" hint="For the AI steps (call reviews). Per company; the server key is the fallback." />
        <Secret row={row("secret.whop_webhook")} label="Whop webhook signing secret" hint="Only for Whop's own webhook. The Zapier door needs nothing here." />
        <Secret row={row("secret.fathom_api_key")} label="Fathom API key" hint="Lets the engine register its own webhook (button below)." />
        <Secret row={row("secret.fathom_webhook")} label="Fathom webhook secret" hint="Set by the register button, or paste one from a webhook you made in Fathom." />
      </tbody></table>
      <button className="btn btn-on" type="submit">Save connections</button>
    </form>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0 18px" }}>
      <form action={testGhlAction}><Hidden slug={slug} id={co.id} section="connections" /><button className="btn" type="submit">Test GHL and refresh the roster</button></form>
      <form action={registerFathomAction} style={{ display: "flex", gap: 8 }}><Hidden slug={slug} id={co.id} section="connections" /><input name="apiKey" type="password" placeholder="Fathom API key (or use the saved one)" style={{ minWidth: 280 }} /><button className="btn" type="submit">{d.inbound.fathomWebhookId ? `Re-register Fathom webhook (${d.inbound.fathomWebhookId})` : "Register Fathom webhook"}</button></form>
    </div>
    {catalog?.errors.length ? <div className="card ready ready-no"><strong>Some GHL lists did not load</strong><ul className="ready-list">{catalog.errors.map((e) => <li key={e} className="warning">{e}</li>)}</ul></div> : null}

    <h2 id="booking">Booking source</h2>
    <form action={setBookingSourceAction} className="form card settings"><Hidden slug={slug} id={co.id} section="booking" />
      <p className="sub">Where appointments live. Currently <strong>{d.bookingSource === "calendly" ? "Calendly" : "GHL calendars"}</strong>.</p>
      <label><input type="radio" name="source" value="ghl" defaultChecked={d.bookingSource === "ghl"} /> GHL calendars (same PIT)</label>
      <label><input type="radio" name="source" value="calendly" defaultChecked={d.bookingSource === "calendly"} /> Calendly</label>
      <div className="grid g2" style={{ marginTop: 8 }}>
        <label>Calendly token (read)<input name="token" type="password" placeholder={row("secret.calendly_token").set ? `kept: ${row("secret.calendly_token").masked}` : "paste"} /></label>
        <label>Host email (limits event types to one person)<input name="userEmail" type="text" placeholder="james@…" /></label>
        <label>Default phone question<input name="phoneQuestion" type="text" defaultValue={row("calendly.phone_question").value ?? ""} placeholder="Phone Number" /></label>
        <label>Default setter question<input name="setterQuestion" type="text" defaultValue={row("calendly.setter_question").value ?? ""} placeholder="Who set this call?" /></label>
      </div>
      <button className="btn btn-on" type="submit">Save booking source</button>
    </form>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="booking" />
      <table className="kv-table"><tbody>
        <tr><td><strong>Company setter rule</strong><div className="mono muted" style={{ fontSize: 11.5 }}>booking.setter_rule · a calendar's own rule wins</div></td>
          <td><select name="b:booking.setter_rule" defaultValue={row("booking.setter_rule").value ?? ""}><option value="">— keep —</option><option value="calendar">calendar: the calendar decides (separate setter calendar)</option><option value="question">question: a named setter means setter-booked</option><option value="either">either: setter calendar or a named setter</option></select><input type="hidden" name="k:booking.setter_rule" value="text" /></td><td>{row("booking.setter_rule").value ?? "calendar (default)"}</td></tr>
        <Pick row={row("crm.default_closer")} options={userOpts} />
      </tbody></table>
      <button className="btn btn-on" type="submit">Save booking rules</button>
    </form>

    <h2 id="calendars">Calendars</h2>
    <p className="sub">Each calendar: the call type it books, how setter-vs-self is decided on it, and which booking questions mean what (one per line, <code>name = question text as it appears</code>; <code>setter</code> and <code>phone</code> are special, anything else becomes <code>appointment.answers.name</code>).{d.liveCalendarsError ? <span className="bad"> Could not list calendars from the source: {d.liveCalendarsError}</span> : null}</p>
    {[...d.calendars.map((c) => ({ id: c.external_id, name: c.name, url: c.booking_url ?? undefined, note: undefined as string | undefined, cur: c })), ...unmapped.map((l) => ({ id: l.id, name: l.name, url: l.bookingUrl, note: l.note, cur: undefined }))].map((c) => (
      <form key={c.id} action={saveCalendarAction} className="form card settings calendar"><Hidden slug={slug} id={co.id} section="calendars" />
        <input type="hidden" name="externalId" value={c.id} /><input type="hidden" name="name" value={c.name} /><input type="hidden" name="bookingUrl" value={c.url ?? ""} />
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}><strong>{c.name}</strong><span className="mono muted" style={{ fontSize: 11.5 }}>{c.id}</span>{c.note ? <span className="muted">· {c.note}</span> : null}{c.cur ? <span className={`badge ${c.cur.active ? "b-live" : "b-type"}`}>{c.cur.active ? "active" : "inactive"}</span> : <span className="badge b-shadow">not mapped</span>}</div>
        <div className="grid g4" style={{ marginTop: 8 }}>
          <label>Call type<select name="term" defaultValue={c.cur?.appointment_term ?? ""} required><option value="">—</option>{d.terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>Setter or self?<select name="booking" defaultValue={c.cur?.config.booking ?? (c.cur?.self_booked === true ? "self" : c.cur?.self_booked === false ? "setter" : "company")}><option value="company">company rule</option><option value="self">always self-booked</option><option value="setter">always setter-booked</option><option value="question">decided by the setter question</option></select></label>
          <label>Role<select name="role" defaultValue={row("calendar.closer_call").value === c.id ? "closer_call" : row("calendar.booking").value === c.id ? "booking" : ""}><option value="">—</option><option value="closer_call">the closer call (calendar.closer_call)</option><option value="booking">the booking link we send (calendar.booking)</option></select></label>
          <label>Active<select name="active" defaultValue={c.cur && !c.cur.active ? "off" : "on"}><option value="on">yes, poll it</option><option value="off">no</option></select></label>
        </div>
        <label>Questions<textarea name="questions" rows={3} defaultValue={questionsText(c.cur?.config.questions)} placeholder={"setter = Who set this call for you\nphone = Best number\nnoticing_for = How long have you been noticing"} /></label>
        <button className="btn btn-on" type="submit">{c.cur ? "Save calendar" : "Map this calendar"}</button>
      </form>))}
    {!d.calendars.length && !unmapped.length ? <div className="empty">No calendars yet. Connect the booking source above.</div> : null}

    <h2 id="crm">CRM ids the workflows use</h2>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="crm" />
      {(["pipelines", "stages", "contact_fields", "opportunity_fields", "associations", "calendars", "other"] as const).map((g) => { const rs = group(g).filter((r) => !["crm.location_id", "crm.default_closer"].includes(r.key)); if (!rs.length) return null;
        const opts = g === "pipelines" ? pipeOpts : g === "stages" ? stageOpts : g === "contact_fields" ? cfOpts : g === "opportunity_fields" ? ofOpts : g === "associations" ? assocOpts : g === "calendars" ? calOpts : undefined;
        return <div key={g}><h3>{g.replace(/_/g, " ")}</h3><table className="kv-table"><tbody>{rs.map((r) => <Pick key={r.key} row={r} options={opts && opts.length ? opts : undefined} />)}</tbody></table></div>; })}
      {!catalog ? <div className="muted">Connect GHL above and the pipelines, stages, fields and associations become drop-downs.</div> : null}
      <button className="btn btn-on" type="submit">Save CRM ids</button>
    </form>

    <h2 id="slack">Slack</h2>
    <form action={saveSlackAction} className="form card settings"><Hidden slug={slug} id={co.id} section="slack" />
      <p className="sub">{d.slack ? <>Connected to workspace <span className="mono">{d.slack.team_id}</span>.</> : "Not connected: every Slack post is recorded but never posted."} A bot token (xoxb-…) from a Slack app with chat:write; paste <code>disconnect</code> to remove it.</p>
      <div style={{ display: "flex", gap: 8 }}><input name="botToken" type="password" placeholder="xoxb-…" style={{ minWidth: 320 }} /><button className="btn btn-on" type="submit">{d.slack ? "Replace token" : "Connect Slack"}</button></div>
    </form>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="slack" />
      <table className="kv-table"><tbody>{group("slack").map((r) => <Pick key={r.key} row={r} placeholder="C0123ABCDEF (channel id)" />)}</tbody></table>
      <button className="btn btn-on" type="submit">Save channels</button>
    </form>

    <h2 id="prompts">Prompts</h2>
    <form action={saveBindingsAction} className="form card settings"><Hidden slug={slug} id={co.id} section="prompts" />
      <p className="sub">What the AI is told before it reads a transcript. Each ends with the JSON shape the workflow expects; keep that part.</p>
      {group("prompts").map((r) => <label key={r.key}><strong>{humanKey(r.key)}</strong> <span className="mono muted" style={{ fontSize: 11.5 }}>{r.key}{r.usedBy.length ? ` · ${r.usedBy.join(", ")}` : ""}</span><textarea name={`b:${r.key}`} rows={8} defaultValue={r.value ?? ""} /><input type="hidden" name={`k:${r.key}`} value="text" /></label>)}
      {group("prompts").length ? <button className="btn btn-on" type="submit">Save prompts</button> : <div className="muted">No installed workflow uses a prompt.</div>}
    </form>

    <h2 id="inbound">Inbound doors</h2>
    <div className="card settings">
      <table className="kv-table"><tbody>
        <tr><td><strong>Whop webhook</strong></td><td className="mono">{d.inbound.whop}</td><td>needs the signing secret above</td></tr>
        <tr><td><strong>Fathom webhook</strong></td><td className="mono">{d.inbound.fathom}</td><td>{d.inbound.fathomWebhookId ? `registered (${d.inbound.fathomWebhookId})` : "register above, or make one in Fathom and paste its secret"}</td></tr>
        <tr><td><strong>Zapier → payment</strong></td><td className="mono">{d.inbound.zapierPayment}</td><td>header x-engine-secret</td></tr>
        <tr><td><strong>Zapier → recording</strong></td><td className="mono">{d.inbound.zapierRecording}</td><td>header x-engine-secret</td></tr>
        <tr><td><strong>Zapier secret</strong></td><td className="mono">{d.inbound.secret ?? "— generated on first install —"}</td><td>same for both Zapier doors</td></tr>
      </tbody></table>
    </div>
  </>);
}
