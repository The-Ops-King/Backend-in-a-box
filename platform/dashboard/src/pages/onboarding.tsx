import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, usePage, useAction, type OnboardingPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Sec, Skeleton, Tag, toast } from "~/ui/pieces";
import { ago } from "~/fmt";
import type { FitReport, Intake, IntakeField } from "@/onboarding/intake";
import type { StepId } from "@/onboarding/store";
import type { ConnectionRow } from "@/onboarding/connections";
import type { Research, ResearchAnswers, CalendarAnswer, Role } from "@/onboarding/research";
import type { SlackState } from "@/onboarding/slack";
import type { CrmRun } from "@/onboarding/crm";

/** D143 (#49 P1): standing a client up, step by step. Every step saves; Tyler can stop for days and come back to the same place. */
export function Onboarding() {
  const { slug = "" } = useParams();
  const key = ["onboarding", slug];
  const q = usePage<OnboardingPage>(key, `/api/v1/companies/${slug}/onboarding`, { every: 60_000 });
  const [params, setParams] = useSearchParams();
  // the step on screen stays put when a save marks it done; it moves only when Tyler picks another
  const first = q.data ? (q.data.steps.find((s) => s.built && !s.done) ?? q.data.steps[0]).id : null;
  useEffect(() => { if (first && !params.get("step")) setParams({ step: first }, { replace: true }); }, [first, params, setParams]);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={10} />;
  const d = q.data;
  const next = d.steps.find((s) => s.built && !s.done)?.id ?? null;
  const at = (d.steps.some((s) => s.id === params.get("step")) ? params.get("step") : first) as StepId;
  const step = d.steps.find((s) => s.id === at)!;
  return <>
    <Crumb items={[{ to: "/app", label: "Companies" }, { to: `/app/c/${slug}`, label: d.company.name }]} />
    <NameLine name={`Onboarding ${d.company.name}`} />
    <div className="tagline"><Tag kind={d.kind === "takeover" ? "warn" : "ok"}>{d.kind === "takeover" ? "takeover" : "new offer"}</Tag><Tag kind={d.company.mode}>{d.company.mode}</Tag>
      <span>{d.company.status === "onboarding" ? "nothing runs yet: the engine starts on it at the install step" : d.company.status}</span><span>·</span><span>started {ago(d.started_at)}</span></div>
    <div className="wiz">
      <ol className="wiz-rail">{d.steps.map((s, i) => <li key={s.id}><button type="button" className={`wiz-step ${s.id === at ? "on" : ""}`} onClick={() => setParams({ step: s.id })}>
        <Ic state={s.done ? "ok" : !s.built ? "skip" : s.id === next ? "here" : "stop"} /><span><b>{i + 1}. {s.label}</b><small>{s.done ? `done ${ago(s.done.done_at)}` : !s.built ? "not built yet" : s.about}</small></span>
      </button></li>)}</ol>
      <section className="wiz-body">
        <Sec small={step.about}>{step.label}</Sec>
        {!step.built ? <Empty>This step is not built yet; it comes in the next slice of #49 P1. Until then it is done the way #43 and #44 did it, by hand.</Empty>
          : at === "offer" ? <OfferStep slug={slug} d={d} invalidate={key} />
          : at === "connections" ? <ConnectionsStep slug={slug} d={d} invalidate={key} />
          : at === "research" ? <ResearchStep slug={slug} d={d} invalidate={key} />
          : at === "slack" ? <SlackStep slug={slug} invalidate={key} />
          : at === "crm" ? <CrmStep slug={slug} d={d} invalidate={key} />
          : at === "install" ? <InstallStep slug={slug} d={d} invalidate={key} /> : null}
      </section>
    </div>
  </>;
}

function OfferStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const [a, setA] = useState<Intake>(d.intake);
  const [chosen, setChosen] = useState<string>("");
  const [problems, setProblems] = useState<string[]>([]);
  const [fit, setFit] = useState<FitReport | null>(d.fit);
  useEffect(() => { setA(d.intake); setFit(d.fit); }, [d.intake, d.fit]);
  const save = useAction<{ intake: Intake; playbook?: string }, { playbook: string; fit: FitReport }>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "offer", ...v } }), [invalidate]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setProblems([]);
    try { const r = await save.mutateAsync({ intake: clean(a, d.fields), ...(chosen ? { playbook: chosen } : {}) }); setFit(r.fit); toast(`Saved. Playbook: ${r.fit.playbookName}.`); }
    catch (x) { const p = x instanceof ApiError ? (x.body?.problems as string[] | undefined) : undefined; setProblems(p ?? [(x as Error).message]); window.scrollTo({ top: 0, behavior: "smooth" }); }
  };
  const sections = [...new Set(d.fields.map((f) => f.section))];
  return <>
    {fit ? <FitView fit={fit} /> : null}
    <form className="form" onSubmit={submit} style={{ marginTop: 14 }}>
      {problems.length ? <div className="banner warn"><strong>Not saved.</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div> : null}
      {sections.map((s) => <div key={s} className="call"><b>{s}</b><div className="g2">{d.fields.filter((f) => f.section === s).map((f) => <IntakeInput key={f.key} f={f} value={a[f.key]} onChange={(v) => setA((x) => ({ ...x, [f.key]: v }))} />)}</div></div>)}
      <div className="call"><label>Playbook<select value={chosen} onChange={(e) => setChosen(e.target.value)}>
        <option value="">The closest to these answers{d.playbook ? ` (now ${d.playbooks.find((p) => p.slug === d.playbook)?.name ?? d.playbook})` : ""}</option>
        {d.playbooks.map((p) => <option key={p.slug} value={p.slug}>{p.name}: {p.about}</option>)}</select></label></div>
      <button className="submit" type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : fit ? "Save the answers again" : "Save and pick the playbook"}</button>
    </form>
  </>;
}

/** Empty answers are left out, so a question not answered reads as not answered. */
const clean = (a: Intake, fields: IntakeField[]): Intake => Object.fromEntries(fields.map((f) => [f.key, a[f.key]]).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))) as Intake;

function IntakeInput({ f, value, onChange }: { f: IntakeField; value: Intake[string] | undefined; onChange: (v: Intake[string]) => void }) {
  const label = <span>{f.label}{f.required ? <span className="req"> *</span> : null}{f.help ? <span className="note"> · {f.help}</span> : null}</span>;
  if (f.type === "multi") { const on = Array.isArray(value) ? value : [];
    return <fieldset className="wide checks"><legend>{label}</legend>{f.options!.map((o) => <label key={o.value}><input type="checkbox" checked={on.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...on, o.value] : on.filter((x) => x !== o.value))} />{o.label}</label>)}</fieldset>; }
  if (f.type === "yesno") return <label>{label}<select value={value === true ? "yes" : value === false ? "no" : ""} onChange={(e) => onChange(e.target.value === "yes" ? true : e.target.value === "no" ? false : "")}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>;
  if (f.type === "select") return <label>{label}<select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
  if (f.type === "textarea") return <label className="wide">{label}<textarea rows={f.key === "journey" ? 5 : 3} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} /></label>;
  return <label>{label}<input type="text" inputMode={f.type === "money" ? "decimal" : undefined} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} /></label>;
}

const FIT_WORDS = { build: "To build", tweak: "Needs a tweak", off: "Stays off", fits: "Fits" } as const;
function FitView({ fit }: { fit: FitReport }) {
  const by = (k: keyof typeof FIT_WORDS) => fit.workflows.filter((w) => w.fit === k);
  return <div className="call" style={{ marginTop: 14 }}>
    <div className="hd"><b>Playbook: {fit.playbookName}</b><span className="note">{fit.why}</span></div>
    {fit.notes.map((n) => <div key={n} className="banner warn" style={{ marginTop: 0 }}>{n}</div>)}
    {fit.gaps.length ? <><b>Build list for this client</b><ul className="note">{fit.gaps.map((g) => <li key={g}>{g}</li>)}</ul></> : <p className="note">Nothing to build: everything this offer needs exists.</p>}
    {(["build", "tweak", "off"] as const).map((k) => by(k).length ? <Fold key={k} open={k !== "off"} title={<>{FIT_WORDS[k]} · {by(k).length}</>}><div className="rows">{by(k).map((w) => <div key={w.slug} className="row noicon"><span className="mid"><span className="nm">{w.name}</span><span className="sub">{w.why}</span></span><Tag kind={k === "build" ? "warn" : ""}>{k}</Tag></div>)}</div></Fold> : null)}
    <Fold title={<>{FIT_WORDS.fits} · {by("fits").length}</>}><div className="rows">{by("fits").map((w) => <div key={w.slug} className="row noicon"><span className="mid"><span className="nm">{w.name}</span><span className="sub">{w.why}</span></span><Tag kind="ok">fits</Tag></div>)}</div></Fold>
    {fit.others.length ? <p className="note">Other playbooks: {fit.others.map((o) => `${o.name} (${o.differs.length ? o.differs.join("; ") : "also matches"})`).join(" · ")}</p> : null}
  </div>;
}

/** D144: each key the offer needs, tested live before it is kept; a kept key is never shown again, only "ends with 1234". */
function ConnectionsStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  if (!d.steps.find((s) => s.id === "offer")!.done) return <Empty>Answer The offer first: it says which tools this client runs on, and so which keys are needed.</Empty>;
  const passed = d.connections.filter((r) => r.check?.ok).length;
  return <>
    <p className="note">{passed} of {d.connections.length} working. A key is tested against its service before it is kept; one that fails is not stored. Kept keys are encrypted and never shown again.</p>
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>{d.connections.map((r) => <ConnectionCard key={r.id} slug={slug} r={r} invalidate={invalidate} />)}</div>
  </>;
}

function ConnectionCard({ slug, r, invalidate }: { slug: string; r: ConnectionRow; invalidate: string[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(""); const [error, setError] = useState<string | null>(null);
  const send = useAction<Record<string, unknown>, { check: NonNullable<ConnectionRow["check"]> }>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "connection", id: r.id, ...v } }), [invalidate]);
  const run = async (v: Record<string, unknown>) => {
    setError(null);
    try { const out = await send.mutateAsync(v); setValues({}); setFrom(""); toast(`${r.label}: ${out.check.detail}`); }
    catch (x) { setError((x as Error).message); }
  };
  const allSet = r.fields.every((f) => f.set);
  const typed = r.fields.some((f) => values[f.name]?.trim());
  return <form className="form call" onSubmit={(e) => { e.preventDefault(); run({ values }); }} autoComplete="off">
    <div className="hd"><b>{r.label}</b><span className="note">{r.why}</span>
      {r.check ? <Tag kind={r.check.ok ? "ok" : "warn"}>{r.check.ok ? "works" : "failed"}</Tag> : <Tag>not connected</Tag>}</div>
    {r.check && !error ? <p className="note">{r.check.ok ? r.check.detail : r.check.error} · tested {ago(r.check.at)}</p> : null}
    {error ? <div className="banner warn" style={{ marginTop: 0 }}>{error}</div> : null}
    <div className="g2">{r.fields.map((f) => <label key={f.name} className={r.fields.length === 1 ? "wide" : ""}><span>{f.label}<span className="note"> · {f.help}</span></span>
      <input type={f.kind === "secret" ? "password" : "text"} autoComplete="new-password" spellCheck={false} value={values[f.name] ?? ""} placeholder={f.set ? `${f.shown}${f.kind === "secret" ? "; leave blank to keep it" : ""}` : ""}
        onChange={(e) => setValues((x) => ({ ...x, [f.name]: e.target.value }))} /></label>)}</div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <button className="btn" type="submit" disabled={send.isPending || !typed}>{send.isPending ? "Testing…" : allSet ? "Test and replace" : "Test and save"}</button>
      {allSet ? <button className="btn" type="button" disabled={send.isPending} onClick={() => run({})}>Test again</button> : null}
      {r.copyFrom.length ? <><select value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "auto" }} aria-label={`copy ${r.label} key from`}><option value="">or copy the key from…</option>{r.copyFrom.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <button className="btn" type="button" disabled={send.isPending || !from} onClick={() => run({ copyFrom: from })}>Copy and test</button></> : null}
    </div>
  </form>;
}

const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
const CALL_WORDS: Record<CalendarAnswer["call_type"], string> = { closing: "Closing call (the offer is made)", first_call: "First call (discovery, triage)", qualifying: "Qualifying (a step before the close)", follow_up: "Follow-up", ignore: "Ignore: not part of this offer" };
const BOOKED_WORDS = { self: "the lead books it", setter: "a setter books it", question: "a booking question names the setter", company: "the company rule" } as const;
const ROLE_WORDS: Record<Role, string> = { closer: "Closer", setter: "Setter", manager: "Manager", owner: "Owner", staff: "Staff", none: "Not on this offer" };

/** D145: what their accounts have, the AI's guesses filled in, Tyler confirms each calendar and each person. */
function ResearchStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const r = d.research;
  const [ans, setAns] = useState<ResearchAnswers | null>(r?.answers ?? null);
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => { setAns(r?.answers ?? null); }, [r?.at]);
  const read = useAction<void, { research: Research }>(() => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "research" } }), [invalidate]);
  const save = useAction<ResearchAnswers, { research: Research }>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "research", answers: v } }), [invalidate]);
  if (!d.steps.find((s) => s.id === "connections")!.done) return <Empty>Finish Connections first: research reads their accounts with those keys.</Empty>;
  const doRead = async () => { setProblems([]); try { const out = await read.mutateAsync(); setAns(out.research.answers); toast(`Read ${out.research.calendars.length} calendars and ${out.research.users.length} people.`); } catch (x) { toast((x as Error).message, true); } };
  const doSave = async (e: React.FormEvent) => { e.preventDefault(); if (!ans) return; setProblems([]);
    try { await save.mutateAsync(ans); toast("Research answers saved."); } catch (x) { const p = x instanceof ApiError ? (x.body?.problems as string[] | undefined) : undefined; setProblems(p ?? [(x as Error).message]); window.scrollTo({ top: 0, behavior: "smooth" }); } };
  const head = <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <button className="btn" type="button" onClick={doRead} disabled={read.isPending}>{read.isPending ? "Reading their accounts… (up to a minute)" : r ? "Read their accounts again" : "Read their accounts"}</button>
    {r ? <span className="note">read {ago(r.at)} · {r.source === "calendly" ? "Calendly event types" : "GHL calendars"} · your answers are kept on a re-read</span> : null}</div>;
  if (!r || !ans) return <>{head}<p className="note" style={{ marginTop: 10 }}>Reads their calendars, team, boards and their own GHL workflows, and asks the AI which calendar is which. Nothing is written to their accounts.</p></>;
  const setCal = (id: string, x: Partial<CalendarAnswer>) => setAns((a) => a && ({ ...a, calendars: { ...a.calendars, [id]: { ...(a.calendars[id] ?? { call_type: "closing" }), ...x } as CalendarAnswer } }));
  const closing = r.calendars.filter((k) => ans.calendars[k.id]?.call_type === "closing");
  const usable = r.calendars.filter((k) => ans.calendars[k.id] && ans.calendars[k.id].call_type !== "ignore");
  return <>
    {head}
    {r.errors.length ? <div className="banner warn"><strong>Some of it could not be read.</strong><ul>{r.errors.map((e) => <li key={e}>{e}</li>)}</ul></div> : null}
    {r.proposal ? <div className="banner"><strong>The AI read it as:</strong> {r.proposal.summary}{r.proposal.questions.length ? <><br /><strong>It still asks:</strong><ul>{r.proposal.questions.map((q) => <li key={q}>{q}</li>)}</ul></> : null}</div>
      : r.proposalError ? <div className="banner wait">{r.proposalError}</div> : null}
    <form className="form" onSubmit={doSave} style={{ marginTop: 14 }}>
      {problems.length ? <div className="banner warn"><strong>Saved, but not done yet:</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div> : null}
      <div className="call"><b>Calendars · {r.calendars.length}</b>
        {r.calendars.length === 0 ? <Empty>No calendars came back.</Empty> : r.calendars.map((k) => { const x = ans.calendars[k.id];
          return <div key={k.id} className="cal-row">
            <div><b>{k.name}</b>{k.active === false ? <Tag>inactive</Tag> : null}<div className="note">{[k.hosts?.length ? k.hosts.map((h) => h.name).join(", ") : "", k.pooling ?? "", k.questions?.length ? `asks: ${k.questions.map((q) => q.name).join("; ")}` : ""].filter(Boolean).join(" · ")}</div>
              {r.proposal?.why[k.id] ? <div className="note">AI: {r.proposal.why[k.id]}</div> : null}</div>
            <div className="g2">
              <label><span>It books</span><select value={x?.call_type ?? ""} onChange={(e) => setCal(k.id, { call_type: e.target.value as CalendarAnswer["call_type"] })}><option value="">—</option>{(Object.keys(CALL_WORDS) as CalendarAnswer["call_type"][]).map((t) => <option key={t} value={t}>{CALL_WORDS[t]}</option>)}</select></label>
              {x && x.call_type !== "ignore" ? <label><span>Booked by</span><select value={x.booking ?? "company"} onChange={(e) => setCal(k.id, { booking: e.target.value as CalendarAnswer["booking"] })}>{(Object.keys(BOOKED_WORDS) as (keyof typeof BOOKED_WORDS)[]).map((b) => <option key={b} value={b}>{BOOKED_WORDS[b]}</option>)}</select></label> : null}
              {x && x.call_type !== "ignore" ? <label className="wide"><span>Their name for the call<span className="note"> · optional, e.g. Demo call</span></span><input value={x.name ?? ""} onChange={(e) => setCal(k.id, { name: e.target.value || undefined })} /></label> : null}
            </div></div>; })}
        <div className="g2">
          <label><span>The closer call<span className="note"> · the closing calendar the team works from</span></span><select value={ans.closerCall ?? ""} onChange={(e) => setAns({ ...ans, closerCall: e.target.value || undefined })}><option value="">—</option>{closing.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
          <label><span>The booking link<span className="note"> · what the engine sends a lead to book</span></span><select value={ans.bookingCalendar ?? ""} onChange={(e) => setAns({ ...ans, bookingCalendar: e.target.value || undefined })}><option value="">the closer call</option>{usable.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
        </div></div>
      <div className="call"><b>Team · {r.users.length} in GHL</b>
        {r.users.map((u) => <label key={u.id} className="team-row"><span>{u.name}<span className="note"> · {u.email ?? "no email"}</span></span>
          <select value={ans.team[u.id] ?? "staff"} onChange={(e) => setAns({ ...ans, team: { ...ans.team, [u.id]: e.target.value as Role } })}>{(Object.keys(ROLE_WORDS) as Role[]).map((x) => <option key={x} value={x}>{ROLE_WORDS[x]}</option>)}</select></label>)}</div>
      <Fold title={<>Their GHL · {n(r.pipelines.length, "board")}, {n(r.objects.length, "custom object")}, {n(r.workflows.length, "workflow")}</>}>
        <p className="note">Boards: {r.pipelines.map((p) => `${p.name} (${p.stages.length} stages)`).join(", ") || "none"}</p>
        <p className="note">Custom objects: {r.objects.map((o) => o.label).join(", ") || "none"}</p>
        <p className="note">Their own GHL workflows (the GHL filters step goes through each): {r.workflows.map((w) => `${w.name}${w.status === "published" ? "" : ` (${w.status})`}`).join(" · ") || "none"}</p>
      </Fold>
      <button className="submit" type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save the answers"}</button>
    </form>
  </>;
}

/** D146: the app made from a generated manifest, its token tested, then a channel for each slot. */
function SlackStep({ slug, invalidate }: { slug: string; invalidate: string[] }) {
  const key = ["onboarding-slack", slug];
  const q = usePage<SlackState>(key, `/api/v1/companies/${slug}/onboarding/slack`, { every: 120_000 });
  const post = useAction<Record<string, unknown>, { detail?: string }>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "slack", ...v } }), [key, invalidate]);
  const [opts, setOpts] = useState<SlackState["options"] | null>(null);
  const [token, setToken] = useState(""); const [secret, setSecret] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (q.data) { setOpts(q.data.options); setPicks(Object.fromEntries(q.data.channels.map((c) => [c.key, c.value ?? ""]))); } }, [q.data]);
  if (!q.data || !opts) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={6} />;
  const s = q.data;
  const run = async (v: Record<string, unknown>, done: string) => { setErr(null); try { const r = await post.mutateAsync(v); toast(r.detail ?? done); return true; } catch (x) { const p = x instanceof ApiError ? (x.body?.problems as string[] | undefined) : undefined; setErr(p ? p.join("; ") : (x as Error).message); return false; } };
  const copy = async () => { try { await navigator.clipboard.writeText(s.manifest ?? ""); toast("Manifest copied."); } catch { toast("Select the manifest and copy it.", true); } };
  const name = (id: string | null) => s.visible?.find((c) => c.id === id)?.name;
  return <>
    {err ? <div className="banner warn">{err}</div> : null}
    <div className="call form"><b>1. Make the app</b>
      <div className="g2">
        <label><span>App name</span><input value={opts.appName} onChange={(e) => setOpts({ ...opts, appName: e.target.value })} /></label>
        <label><span>The bot's name in Slack</span><input value={opts.botName} onChange={(e) => setOpts({ ...opts, botName: e.target.value })} /></label>
        <label className="wide" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={opts.commands} onChange={(e) => setOpts({ ...opts, commands: e.target.checked })} />
          <span>No other engine app is in this workspace (adds the slash commands: Slack gives a command to the app installed last)</span></label>
      </div>
      <div style={{ display: "flex", gap: 8 }}><button className="btn" type="button" disabled={post.isPending} onClick={() => run({ options: opts }, "Manifest updated.")}>Update the manifest</button>
        {s.manifest ? <button className="btn" type="button" onClick={copy}>Copy the manifest</button> : null}</div>
      {s.manifest ? <pre className="manifest">{s.manifest}</pre> : <div className="banner warn" style={{ marginTop: 0 }}>{s.manifestError}</div>}
      <p className="note">api.slack.com/apps → Create New App → From an app manifest → pick the workspace → YAML → paste → Create → Install to Workspace.</p>
    </div>
    <form className="call form" autoComplete="off" onSubmit={async (e) => { e.preventDefault(); if (await run({ token, signingSecret: secret }, "Slack connected.")) { setToken(""); setSecret(""); } }}>
      <div className="hd"><b>2. Connect it</b>{s.connected ? <Tag kind="ok">connected to {s.connected.team}</Tag> : <Tag>not connected</Tag>}</div>
      <div className="g2">
        <label><span>Bot User OAuth Token<span className="note"> · OAuth &amp; Permissions, starts xoxb-</span></span><input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s.connected ? "set; paste a new one to replace it" : ""} /></label>
        <label><span>Signing Secret<span className="note"> · Basic Information → App Credentials</span></span><input type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={s.signingSet ? "set; paste a new one to replace it" : ""} /></label>
      </div>
      <div><button className="btn" type="submit" disabled={post.isPending || !token || !secret}>{post.isPending ? "Testing…" : "Test and save"}</button></div>
      <p className="note">The token is tested with Slack before it is kept. Slack has no check for a signing secret: its shape is checked here, and Slack's first event proves it.</p>
    </form>
    {s.connected ? <form className="call form" onSubmit={(e) => { e.preventDefault(); run({ channels: picks }, "Channels saved."); }}>
      <b>3. Which channel is for what</b>
      {s.visible === null ? <div className="banner warn" style={{ marginTop: 0 }}>Slack would not list the channels: the app needs channels:read and groups:read (reinstall it from the manifest).</div> : null}
      {s.channels.map((c) => { const picked = s.visible?.find((v) => v.id === picks[c.key]);
        return <label key={c.key} className="team-row"><span>{c.label}<span className="note"> · {c.about}{c.instead ? `; empty, it posts to ${c.instead}` : ""}{picked && !picked.is_member ? " · invite the bot to it" : ""}</span></span>
          <select value={picks[c.key] ?? ""} onChange={(e) => setPicks({ ...picks, [c.key]: e.target.value })}><option value="">{c.instead ? `— (${c.instead})` : "—"}</option>{(s.visible ?? []).map((v) => <option key={v.id} value={v.id}>{v.is_private ? "🔒 " : "#"}{v.name}</option>)}{picks[c.key] && !name(picks[c.key]) ? <option value={picks[c.key]}>{picks[c.key]}</option> : null}</select></label>; })}
      <div><button className="btn" type="submit" disabled={post.isPending}>Save the channels</button></div>
    </form> : null}
    <p className="note">{s.ready ? "Done: the bot is connected and every channel is set." : "Done once the bot is connected and every slot with nothing to fall back on has a channel."}</p>
  </>;
}

const ACTION_WORDS: Record<string, string> = { create: "Will be made", "change-on-ours": "Will be changed (ours only)", "missing-on-ours": "Missing from ours", blocked: "Blocked: needs a hand", "exists-differs": "There, but not as the playbook has it", exists: "Already there" };
/** D147: what the playbook needs in their GHL, planned (reads only), then built (only what is missing). */
function CrmStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const [prefix, setPrefix] = useState(d.crm?.options.prefix ?? "");
  const [err, setErr] = useState<string | null>(null);
  const run = useAction<"plan" | "build", { crm: CrmRun }>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "crm", run: v } }), [invalidate]);
  const opts = useAction<{ prefix: string }>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "crm", options: v } }), [invalidate]);
  const need = d.steps.find((s) => s.id === "connections")!.done && d.steps.find((s) => s.id === "research")!.done;
  if (!need) return <Empty>Finish Connections and Research first: the build uses the GHL token, and the closers and call types come from Research.</Empty>;
  const last = d.crm?.last ?? null;
  const go = async (v: "plan" | "build") => {
    if (v === "build" && !confirm("Build in their GHL now? Only what is missing is made; nothing of theirs is renamed, changed or deleted.")) return;
    setErr(null); try { const r = await run.mutateAsync(v); toast(v === "plan" ? `Planned: ${r.crm.summary}` : `Built: ${r.crm.summary}`); } catch (x) { setErr((x as Error).message); }
  };
  const lines = last ? (last.after ?? last.plan) : [];
  const by = (a: string) => lines.filter((l) => l.action === a);
  return <>
    {err ? <div className="banner warn">{err}</div> : null}
    <form className="call form" onSubmit={async (e) => { e.preventDefault(); try { await opts.mutateAsync({ prefix }); toast("Saved: plan again to see what it makes."); } catch (x) { setErr((x as Error).message); } }}>
      <b>Names</b>
      <label><span>Prefix<span className="note"> · only when their GHL account is shared with another business or offer: it goes in front of every board, field and record name we make, so nothing of ours meets theirs. Empty in an account of its own.</span></span><input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="none" /></label>
      <div><button className="btn" type="submit" disabled={opts.isPending || prefix === (d.crm?.options.prefix ?? "")}>Save the prefix</button></div>
    </form>
    <div className="call">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" type="button" disabled={run.isPending} onClick={() => go("plan")}>{run.isPending ? "Reading their GHL…" : last ? "Plan again (reads only)" : "Plan (reads only)"}</button>
        {last && !last.error && !last.applied && by("create").length ? <button className="btn warn" type="button" disabled={run.isPending} onClick={() => go("build")}>Build the {by("create").length} missing</button> : null}
        {last && last.applied && !last.error ? <button className="btn" type="button" disabled={run.isPending} onClick={() => go("build")}>Build again (makes only what is missing)</button> : null}
      </div>
      {last ? <p className="note">{last.applied ? "built" : "planned"} {ago(last.at)} · {last.summary}{last.applied && last.missing.length ? ` · still missing after the build: ${last.missing.join(", ")}` : ""}</p> : <p className="note">The plan reads their GHL and lists, line by line, what is there and what would be made. Nothing is written until you build.</p>}
      {last?.error ? <div className="banner warn" style={{ marginTop: 0 }}>GHL: {last.error}</div> : null}
      {(["blocked", "exists-differs", "create", "change-on-ours", "missing-on-ours", "exists"] as const).map((a) => by(a).length ? <Fold key={a} open={a !== "exists"} title={<>{ACTION_WORDS[a]} · {by(a).length}</>}>
        <div className="rows">{by(a).map((l, i) => <div key={i} className="row noicon"><span className="mid"><span className="nm" style={{ whiteSpace: "normal" }}>{l.what}</span>{l.detail ? <span className="sub">{l.detail}</span> : null}</span></div>)}</div></Fold> : null)}
    </div>
    <p className="note">{d.steps.find((s) => s.id === "crm")!.done ? "Done: everything the playbook needs is in their GHL." : "Done once a build leaves nothing to make."}</p>
  </>;
}

/** D148: everything the steps learned, installed in one go: every workflow off, the playbook's copies on, the company in ghost. */
function InstallStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const [out, setOut] = useState<{ installed: string[]; calendars: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = useAction<void, { installed: string[]; calendars: string[] }>(() => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "install" } }), [invalidate]);
  const todo = d.steps.filter((s) => ["offer", "connections", "research", "slack", "crm"].includes(s.id) && !s.done);
  if (todo.length) return <Empty>Finish {todo.map((s) => s.label).join(", ")} first: install puts together what they learned.</Empty>;
  const done = d.steps.find((s) => s.id === "install")!.done;
  const r = d.research!;
  const mapped = r.calendars.filter((k) => r.answers.calendars[k.id] && r.answers.calendars[k.id].call_type !== "ignore");
  const go = async () => {
    if (!confirm("Install now? Every workflow goes in OFF and the company runs in ghost: the engine reads their accounts and writes and sends nothing.")) return;
    setErr(null); try { setOut(await run.mutateAsync()); toast("Installed: everything off, running in ghost."); } catch (x) { setErr((x as Error).message); }
  };
  return <>
    {err ? <div className="banner warn">{err}</div> : null}
    <div className="call">
      <b>What goes in</b>
      <ul className="note">
        <li>The {d.playbooks.find((p) => p.slug === d.playbook)?.name ?? d.playbook} playbook: every shipped workflow, its own copies where it changes them, every one OFF.</li>
        <li>{mapped.length} calendar{mapped.length === 1 ? "" : "s"}: {mapped.map((k) => k.name).join(", ")}; the closer call is {r.calendars.find((k) => k.id === r.answers.closerCall)?.name ?? "not set"}.</li>
        <li>The team: {r.users.filter((u) => r.answers.team[u.id] && r.answers.team[u.id] !== "staff" && r.answers.team[u.id] !== "none").map((u) => `${u.name} (${r.answers.team[u.id]})`).join(", ") || "nobody but staff"}.</li>
        <li>The GHL ids the CRM build found or made, and what each Sales Call option means.</li>
        {d.kind === "new" ? <li>SMS off: a new account has no approved number yet. Turn it on once A2P is through.</li> : null}
        <li>Whop and Fathom get the engine's own webhooks, when their keys are connected.</li>
      </ul>
      <p className="note">Then the company turns active in <b>ghost</b>: the engine reads their accounts, runs nothing (every workflow is off), writes nothing, sends nothing. Installing again changes nothing.</p>
      <div><button className="btn warn" type="button" onClick={go} disabled={run.isPending}>{run.isPending ? "Installing…" : done ? "Install again" : "Install"}</button></div>
      {done ? <p className="note">Installed {ago(done.done_at)}.</p> : null}
    </div>
    {out ? <div className="call"><b>What the install did</b><ul className="note">{[...out.calendars, ...out.installed].map((l) => <li key={l}>{l}</li>)}</ul></div> : null}
  </>;
}
