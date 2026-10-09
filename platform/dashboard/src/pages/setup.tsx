import { Link, useParams } from "react-router-dom";
import { usePage, type SetupPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Sec, Skeleton, Tag } from "~/ui/pieces";

/** Everything this company's workflows need, read-only (D42): what is set, what is missing, by name where the CRM can name it. */
export function Setup() {
  const { slug = "" } = useParams();
  const q = usePage<SetupPage>(["setup", slug], `/api/v1/companies/${slug}/setup`, { every: 60_000 });
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={10} />;
  const d = q.data; const co = d.company;
  type Row = { key: string; label: string; set: boolean; value: string | null; name?: string | null; required: boolean; used_by: string[] };
  const KV = ({ rows }: { rows: Row[] }) => rows.length ? <div className="rows">{rows.map((r) => <div key={r.key} className={`row ${r.set ? "" : "off"}`}><Ic state={r.set ? "ok" : r.required ? "warn" : "skip"} /><span className="mid"><span className="nm">{r.label}</span><span className="sub"><span className="mono">{r.key}</span>{r.used_by.length ? <span>· {r.used_by.join(", ")}</span> : null}</span></span><span className="d">{r.set ? (r.name ?? r.value) : r.required ? "missing" : "not set"}</span></div>)}</div> : <Empty>Nothing here.</Empty>;
  const kv = (pairs: [string, string | number | boolean | null | undefined][]) => <dl className="kv">{pairs.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{typeof v === "boolean" ? (v ? "yes" : "no") : String(v)}</dd></div>)}</dl>;
  const blockers = d.readiness.issues.filter((i) => i.level === "blocker"), warnings = d.readiness.issues.filter((i) => i.level === "warning");
  return <>
    <Crumb items={[{ to: `/app/c/${slug}`, label: co.name }]} />
    <NameLine name="Setup" />
    <div className="tagline">{d.readiness.ready ? <Tag kind="ok">ready</Tag> : <Tag kind="warn">{blockers.length} blocker{blockers.length === 1 ? "" : "s"}</Tag>}<span>read-only · change it with the install API or the CLI</span></div>
    {blockers.length ? <div className="rows">{blockers.map((i, n) => <div key={n} className="row"><Ic state="warn" /><span className="mid"><span className="nm" style={{ whiteSpace: "normal" }}>{i.text}</span></span>{i.href ? <Link className="btn" to={i.href}>Open</Link> : null}</div>)}</div> : null}
    {warnings.length ? <Fold title={<>{warnings.length} warning{warnings.length === 1 ? "" : "s"} · nothing is blocked</>}><div className="rows">{warnings.map((i, n) => <div key={n} className="row"><Ic state="skip" /><span className="mid"><span className="nm" style={{ whiteSpace: "normal" }}>{i.text}</span></span>{i.href ? <Link className="btn" to={i.href}>Open</Link> : null}</div>)}</div></Fold> : null}

    <Sec>Company</Sec>
    {kv([["name", d.settings.name], ["time zone", d.settings.timezone], ["mode", d.settings.mode], ["SMS", d.settings.sms_enabled ? "on" : "off (text steps are skipped)"], ["send window", d.settings.send_window], ["receipts in dark hours", d.settings.quiet_allow_transactional], ["program price", d.settings.contract_value_default], ["reached after (seconds)", d.settings.reached_seconds]])}

    <Sec small="from the CRM; closers get the end-of-day link">Team</Sec>
    {d.team.length ? <div className="rows">{d.team.map((u) => <div key={u.id} className="row noicon"><span className="mid"><span className="nm">{u.name}</span><span className="sub"><span>{u.email}</span>{!u.in_crm ? <span>· not in the CRM</span> : null}</span></span><span className="d">{u.role}{u.calls ? ` · ${u.calls} calls` : ""}</span></div>)}</div> : <Empty>No team yet; install pulls the roster from the CRM.</Empty>}

    <Sec>Connections</Sec>
    <KV rows={d.connections} />
    {d.catalog_errors.length ? <p className="note">Some CRM lists did not load: {d.catalog_errors.join("; ")}</p> : null}

    <Sec>Booking</Sec>
    {kv([["source", d.booking.source === "calendly" ? "Calendly" : "GHL calendars"], ["setter rule", d.booking.setter_rule], ["default closer", d.booking.default_closer], ["phone question", d.booking.phone_question], ["setter question", d.booking.setter_question]])}
    <Fold title={<>Call types · {d.call_types.length}</>}><div className="rows">{d.call_types.map((t) => <div key={t.name} className={`row noicon ${t.active ? "" : "off"}`}><span className="mid"><span className="nm">{t.name}</span><span className="sub"><span>{t.category.replace(/_/g, " ")}</span></span></span><span className="d">{t.in_use ? `${t.in_use} calendar${t.in_use === 1 ? "" : "s"}` : ""}</span></div>)}</div></Fold>
    <Fold title={<>Calendars · {d.calendars.length}{d.unmapped_calendars.length ? ` (+${d.unmapped_calendars.length} not mapped)` : ""}</>} open>
      {d.calendars_error ? <p className="note">Live calendars could not be read: {d.calendars_error}</p> : null}
      <div className="rows">{d.calendars.map((c) => <div key={c.id} className={`row noicon ${c.active ? "" : "off"}`}><span className="mid"><span className="nm">{c.name}</span><span className="sub"><span>{c.call_type}</span><span>· {c.booking === "self" ? "always self-booked" : c.booking === "setter" ? "always setter-booked" : c.booking === "question" ? "the setter question decides" : "company rule"}</span>{c.role ? <span>· {c.role}</span> : null}{c.hosts.length ? <span>· {c.hosts.join(", ")}</span> : null}{c.questions.length ? <span>· {c.questions.map((q) => `${q.use} = ${q.text}`).join("; ")}</span> : null}</span></span><span className="d">{c.active ? "polled" : "off"}</span></div>)}
        {d.unmapped_calendars.map((c) => <div key={c.id} className="row noicon off"><span className="mid"><span className="nm">{c.name}</span><span className="sub"><span>not mapped: the engine ignores it</span>{c.hosts.length ? <span>· {c.hosts.join(", ")}</span> : null}</span></span><span className="d">ignored</span></div>)}</div>
    </Fold>

    <Sec>CRM ids the workflows use</Sec>
    {d.crm.length ? d.crm.map((g) => <Fold key={g.group} title={<>{g.group} · {g.rows.filter((r) => r.set).length}/{g.rows.length}</>} open={g.rows.some((r) => !r.set && r.required)}><KV rows={g.rows} /></Fold>) : <Empty>No installed workflow needs a CRM id.</Empty>}

    <Sec>Tags</Sec>
    <p className="note">{d.tags.crm_readable ? "The CRM's tag list, what the workflows add and remove, and how many contacts carry each." : "The CRM's tag list could not be read (the token may lack tags access); workflow tags and contact counts only."}</p>
    {d.tags.rows.length ? <div className="rows">{d.tags.rows.map((t) => <div key={t.tag} className={`row ${t.in_crm === false ? "off" : ""}`}><Ic state={t.in_crm === false ? "warn" : t.added_by.length || t.removed_by.length ? "ok" : "skip"} /><span className="mid"><span className="nm">{t.tag}</span><span className="sub">{t.added_by.length ? <span>added by {t.added_by.join(", ")}</span> : null}{t.removed_by.length ? <span>{t.added_by.length ? "· " : ""}removed by {t.removed_by.join(", ")}</span> : null}{!t.added_by.length && !t.removed_by.length ? <span>no workflow touches it</span> : null}{t.in_crm === false ? <span>· not in the CRM's tag list</span> : null}</span></span><span className="d">{t.on_contacts ? `${t.on_contacts} contact${t.on_contacts === 1 ? "" : "s"}` : "no contacts"}</span></div>)}</div> : <Empty>No tags anywhere yet.</Empty>}

    <Sec>Slack</Sec>
    <p className="note">{d.slack.connected ? `Connected to workspace ${d.slack.team_id}.` : "Not connected: every Slack post is recorded but never posted."}</p>
    <KV rows={d.slack.channels} />

    <Sec>Alerts</Sec>
    <KV rows={d.alerts} />

    <Sec small="what the AI is told before it reads a transcript">Prompts</Sec>
    {d.prompts.length ? d.prompts.map((p) => <Fold key={p.key} title={<>{p.label}{p.used_by.length ? <small> · {p.used_by.join(", ")}</small> : null}</>}><pre className="pre">{p.text || "(empty)"}</pre></Fold>) : <Empty>No installed workflow uses a prompt.</Empty>}

    <Sec>On a schedule</Sec>
    {d.scheduled.length ? <div className="rows">{d.scheduled.map((w) => <Link key={w.id} to={`/app/c/${slug}/w/${w.id}`} className={`row noicon ${w.enabled ? "" : "off"}`}><span className="mid"><span className="nm">{w.name}</span><span className="sub"><span>{w.when}</span></span></span><span className="d">{w.enabled ? "on" : "off"}</span></Link>)}</div> : <Empty>Nothing runs on a schedule.</Empty>}

    <Sec small="where other tools deliver to the engine">Inbound doors</Sec>
    {kv([["Whop webhook", d.inbound.whop], ["Fathom webhook", d.inbound.fathom_webhook_id ? `${d.inbound.fathom} · registered (${d.inbound.fathom_webhook_id})` : d.inbound.fathom], ["Zapier → payment", d.inbound.zapier_payment], ["Zapier → recording", d.inbound.zapier_recording], ["Zapier secret", d.inbound.zapier_secret ?? "generated on first install"]])}

    <Fold title={<>End-of-day form · {d.eod_form.length} questions</>}><div className="rows">{d.eod_form.map((f) => <div key={f.key} className="row noicon"><span className="mid"><span className="nm">{f.label}</span><span className="sub"><span>{f.type}</span><span>· {f.scope === "day" ? "once, for the day" : f.key === "outcome" ? "first, every call" : f.when ? `after ${f.when.join(", ")}` : "after any outcome"}</span>{f.required ? <span>· required</span> : null}{f.options?.length ? <span>· {f.options.join(" / ")}</span> : null}</span></span><span className="d">{f.builtin ? "built in" : ""}</span></div>)}</div></Fold>
  </>;
}
