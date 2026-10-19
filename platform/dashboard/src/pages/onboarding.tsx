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
import type { Message } from "@/onboarding/messages";
import type { TestsState, ScenarioResult } from "@/onboarding/tests";
import type { FiltersState, Mark } from "@/onboarding/filters";

/** D149 (#53 P1): standing a client up, step by step. Every step saves; Tyler can stop for days and come back to the same place. */
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
        {!step.built ? <Empty>This step is not built yet; it comes in the next slice of #53 P1. Until then it is done the way #43 and #44 did it, by hand.</Empty>
          : at === "offer" ? <OfferStep slug={slug} d={d} invalidate={key} />
          : at === "connections" ? <ConnectionsStep slug={slug} d={d} invalidate={key} />
          : at === "research" ? <ResearchStep slug={slug} d={d} invalidate={key} />
          : at === "slack" ? <SlackStep slug={slug} invalidate={key} />
          : at === "crm" ? <CrmStep slug={slug} d={d} invalidate={key} />
          : at === "install" ? <InstallStep slug={slug} d={d} invalidate={key} />
          : at === "messages" ? <MessagesStep slug={slug} d={d} invalidate={key} />
          : at === "filters" ? <FiltersStep slug={slug} d={d} invalidate={key} />
          : at === "test" ? <TestStep slug={slug} d={d} invalidate={key} /> : null}
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

/** D150: each key the offer needs, tested live before it is kept; a kept key is never shown again, only "ends with 1234". */
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

/** D151: what their accounts have, the AI's guesses filled in, Tyler confirms each calendar and each person. */
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

/** D152: the app made from a generated manifest, its token tested, then a channel for each slot. */
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
/** D153: what the playbook needs in their GHL, planned (reads only), then built (only what is missing). */
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

/** D154: everything the steps learned, installed in one go: every workflow off, the playbook's copies on, the company in ghost. */
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

/** D155: every text and email a contact can get, written and approved one by one; changed words need approving again. */
function MessagesStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const key = ["onboarding-messages", slug];
  const q = usePage<{ messages: Message[]; ready: boolean }>(key, `/api/v1/companies/${slug}/onboarding/messages`, { every: 120_000 });
  if (!d.steps.find((s) => s.id === "install")!.done) return <Empty>Install first: the messages are the words in the client's own workflows, which install puts on.</Empty>;
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={6} />;
  const needed = q.data.messages.filter((m) => m.needed), done = needed.filter((m) => m.approved).length;
  const byWf = [...new Set(needed.map((m) => m.workflow))];
  return <>
    <p className="note">{done} of {needed.length} approved. Each text and email is approved as written; changing its words takes the approval back. A placeholder or another client's words cannot be approved. Words saved here are this client's own and survive every template upgrade.</p>
    {byWf.map((wf) => <div key={wf} className="call" style={{ marginTop: 12 }}><b>{wf}</b>{needed.filter((m) => m.workflow === wf).map((m) => <MessageCard key={m.workflowId + m.nodeId} url={`/api/v1/companies/${slug}/onboarding`} extra={{ step: "messages" }} approvable m={m} invalidate={[[...invalidate], key]} />)}</div>)}
    {q.data.messages.some((m) => !m.needed) ? <Fold title={<>Not needed: workflows this offer does not use · {q.data.messages.filter((m) => !m.needed).length}</>}><ul className="note">{q.data.messages.filter((m) => !m.needed).map((m) => <li key={m.workflowId + m.nodeId}>{m.workflow}: {m.title}</li>)}</ul></Fold> : null}
  </>;
}

const MARK_LABEL: Record<Mark, string> = { replaced: "Replaced: ours does it, it goes off at go-live", filtered: "Kept, with the sys-test filter added in GHL", harmless: "Harmless if it fires", off: "Off" };
/** What the engine does that a GHL workflow can fire on (09-possibilities, part B): the guide for marking each one. */
const FIRES_ON = ["Contact tag added or removed (every tag step)", "Pipeline stage changed, opportunity created, won or lost (every card move)", "Contact changed: a custom field (closer, call date, objection, source)",
  "Custom object record (Sales Call)", "Note or task added", "Document sent or signed (the agreement)", "Date reminder on a date field the engine writes", "Customer replied (the test contact replying to our texts)",
  "Appointment status: real bookings only, once live (staged bookings never reach GHL)", "Their Zaps listening to any of the above"];

/**
 * D158: their own GHL workflows, read live, each marked by Tyler after opening it in GHL (the API gives names, not triggers),
 * and the check every move up needs: the list read again, nothing new or unmarked.
 */
function FiltersStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const key = ["onboarding-filters", slug];
  const q = usePage<FiltersState>(key, `/api/v1/companies/${slug}/onboarding/filters`, { every: 120_000 });
  const post = useAction<Record<string, unknown>>((v) => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "filters", ...v } }), [invalidate, key]);
  const [err, setErr] = useState<string | null>(null), [notes, setNotes] = useState<Record<string, string>>({});
  if (!d.connections.some((x) => x.id === "ghl" && x.check?.ok)) return <Empty>Connect their GHL first: the list is read from it.</Empty>;
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={6} />;
  const f = q.data;
  const read = async () => { setErr(null); try { await post.mutateAsync({ read: true }); toast("Read their workflows from GHL."); } catch (x) { setErr((x as Error).message); } };
  const mark = async (id: string, m: Mark) => { setErr(null); try { await post.mutateAsync({ id, mark: m, note: notes[id] ?? "" }); } catch (x) { setErr((x as Error).message); } };
  return <>
    {err ? <div className="banner warn">{err}</div> : null}
    <p className="note">GHL lists their workflows but not what they fire on, so open each one in GHL and mark it. Anything that fires on what the engine does either goes (replaced, off), gets the <code>sys-test</code> filter, or is harmless. The engine checks this list again before every move up a rung.</p>
    <Fold title={<>What the engine does that their workflows can fire on</>}><ul className="note">{FIRES_ON.map((l) => <li key={l}>{l}</li>)}</ul></Fold>
    <div style={{ display: "flex", gap: 8, margin: "12px 0" }}><button className="btn" type="button" disabled={post.isPending} onClick={read}>{f.filters.read_at ? "Read the list again" : "Read their workflows"}</button>
      {f.filters.read_at ? <span className="note">Read {ago(f.filters.read_at)}: {f.rows.length} workflow{f.rows.length === 1 ? "" : "s"}{f.problems.length ? `, ${f.problems.length} to see to` : ", all marked"}.</span> : null}</div>
    {f.rows.map((w) => <div key={w.id} className="cal-row">
      <div className="hd"><b>{w.name}</b><Tag kind={/^(published|active)$/i.test(w.status) ? "warn" : undefined}>{w.status}</Tag>{w.marked ? <Tag kind={w.problem ? "warn" : "ok"}>{w.marked.mark}</Tag> : <Tag>to mark</Tag>}</div>
      {w.problem && w.marked ? <div className="banner warn" style={{ marginTop: 0 }}>{w.problem}</div> : null}
      {w.marked?.note ? <p className="note">{w.marked.note}</p> : null}
      <div className="form"><label><span>Note (optional)</span><input placeholder="what it does, the filter added" value={notes[w.id] ?? ""} onChange={(e) => setNotes({ ...notes, [w.id]: e.target.value })} /></label></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{(Object.keys(MARK_LABEL) as Mark[]).map((m) => <button key={m} className="btn" type="button" disabled={post.isPending || w.marked?.mark === m} onClick={() => mark(w.id, m)} title={MARK_LABEL[m]}>{MARK_LABEL[m]}</button>)}</div>
    </div>)}
    {f.filters.read_at && !f.rows.length ? <Empty>No workflows in their GHL: nothing of theirs can fire on what the engine does.</Empty> : null}
    <div className="call" style={{ marginTop: 12 }}><b>Before every move up</b><AutomationsCheck slug={slug} invalidate={[invalidate, key]} /></div>
  </>;
}

/** D158: the check a move up needs: their list read again live; refused, naming each, while anything is new or unmarked. Used by the next move up, for 30 minutes. */
function AutomationsCheck({ slug, invalidate }: { slug: string; invalidate: string[][] }) {
  const key = ["onboarding-filters", slug];
  const q = usePage<FiltersState>(key, `/api/v1/companies/${slug}/onboarding/filters`, { every: 60_000 });
  const post = useAction<void>(() => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "filters", check: true } }), [...invalidate, key]);
  const [problems, setProblems] = useState<string[] | null>(null), [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (!confirm("Have you looked at their GHL workflows since anything changed? The engine reads the list again now; anything new or not marked stops the move.")) return;
    setErr(null); setProblems(null);
    try { await post.mutateAsync(); toast("Checked: the next move up can go."); }
    catch (x) { setErr((x as Error).message); const p = (x as ApiError).body as { problems?: string[] } | undefined; if (p?.problems) setProblems(p.problems); }
  };
  const fresh = q.data?.check.fresh;
  return <div>
    <p className="note">{fresh ? <>Checked {ago(q.data!.check.at!)}: the next move up (a workflow's or the company's) can go within 30 minutes.</> : <>Every move up a rung needs a fresh check that nothing of theirs fires on what the engine does.</>}</p>
    {err ? <div className="banner warn">{err}</div> : null}
    {problems ? <ul className="note">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
    {!fresh ? <button className="btn" type="button" disabled={post.isPending} onClick={go}>{post.isPending ? "Reading GHL…" : "Check now"}</button> : null}
  </div>;
}

/** D159: the test contact made in their GHL: your own email (the send lock knows it), tagged sys-test, read back at once. */
function MakeTestContact({ slug, suggested, first, invalidate, onMade }: { slug: string; suggested: string | null; first: boolean; invalidate: string[][]; onMade: (id: string) => void }) {
  const [open, setOpen] = useState(first), [email, setEmail] = useState(suggested ?? ""), [phone, setPhone] = useState(""), [err, setErr] = useState<string | null>(null);
  const post = useAction<void, { id: string; email: string; created: boolean }>(() => api(`/api/v1/companies/${slug}/onboarding`, { method: "POST", json: { step: "test", makeContact: true, email, phone } }), invalidate);
  if (!open) return <div><button className="btn" type="button" onClick={() => setOpen(true)}>Make another test contact</button></div>;
  const go = async () => { setErr(null); try { const r = await post.mutateAsync(); onMade(r.id); toast(`${r.created ? "Made" : "Found and tagged"} ${r.email} in their GHL.`); setOpen(false); } catch (x) { setErr((x as Error).message); } };
  return <div className="form">
    {err ? <div className="banner warn">{err}</div> : null}
    <label><span>Your email</span><input type="email" placeholder="jt@jtylerray.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label><span>Your phone (optional: texts on the test rung reach it)</span><input type="tel" placeholder="+1…" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
    <p className="note">Made in their GHL as "Test {"<business>"}" on {email.includes("@") ? email : "your email"} (the send lock lets a locked workflow reach only your own addresses), tagged <code>sys-test</code> (so a workflow filtered on that tag never sees it); its domain becomes a test domain here.</p>
    <div><button className="btn" type="button" disabled={post.isPending || !email.includes("@")} onClick={go}>{post.isPending ? "Making…" : "Make the test contact"}</button></div>
  </div>;
}

/**
 * D157: the test passes. Choose the test contact and the rung, turn the offer's workflows on, then run each journey on that
 * contact (one request each: a journey ticks the company between its steps). Every run a journey started is listed with how it
 * ended; a workflow no journey reaches is checked by hand and accepted with a note.
 */
function TestStep({ slug, d, invalidate }: { slug: string; d: OnboardingPage; invalidate: string[] }) {
  const key = ["onboarding-tests", slug];
  const q = usePage<TestsState>(key, `/api/v1/companies/${slug}/onboarding/tests`, { every: 120_000 });
  const url = `/api/v1/companies/${slug}/onboarding`;
  const post = useAction<Record<string, unknown>, { result?: ScenarioResult }>((v) => api(url, { method: "POST", json: { step: "test", ...v } }), [invalidate, key]);
  const [contact, setContact] = useState<string>(""), [rung, setRung] = useState<"ghost" | "test">("ghost");
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!d.steps.find((s) => s.id === "install")!.done) return <Empty>Install first: the test passes run the client's own workflows, which install puts on.</Empty>;
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton lines={8} />;
  const t = q.data, prepared = t.tests.prepared;
  const chosen = contact || t.tests.contact?.id || t.contacts[0]?.id || "";
  const prepare = async () => {
    setErr(null); setBusy("prepare");
    try { await post.mutateAsync({ prepare: true, contactId: chosen, rung }); toast(`Workflows on, company in ${rung}.`); } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  };
  const run = async (ids: string[]) => {
    setErr(null);
    for (const id of ids) {
      setBusy(id);
      try { const r = await post.mutateAsync({ scenario: id }); if (r.result && !r.result.passed) { toast(`${t.scenarios.find((s) => s.id === id)?.label}: problems found.`); } }
      catch (x) { setErr((x as Error).message); break; }
    }
    setBusy(null);
  };
  const accept = async (workflow: string, note: string) => { setErr(null); try { await post.mutateAsync({ accept: workflow, note }); setNotes({ ...notes, [workflow]: "" }); } catch (x) { setErr((x as Error).message); } };
  return <>
    {err ? <div className="banner warn">{err}</div> : null}
    <div className="call">
      <b>Test contact and rung</b>
      {t.contacts.length ? <div className="form">
        <label><span>Test contact</span><select value={chosen} onChange={(e) => setContact(e.target.value)}>{t.contacts.map((x) => <option key={x.id} value={x.id}>{x.name}{x.email ? ` (${x.email})` : ""}</option>)}</select></label>
        <label><span>Rung</span><select value={rung} onChange={(e) => setRung(e.target.value as "ghost" | "test")}>
          <option value="ghost">Ghost: nothing written or sent anywhere; each run says what it would do</option>
          <option value="test">Test: the test contact's runs really write and send; everyone else stays ghost</option></select></label>
      </div> : <p className="note">No test contact yet.</p>}
      <MakeTestContact slug={slug} suggested={t.suggestedEmail} first={!t.contacts.length} invalidate={[invalidate, key]} onMade={setContact} />
      {rung === "test" && d.company.mode === "ghost" ? <AutomationsCheck slug={slug} invalidate={[invalidate, key]} /> : null}
      <div><button className="btn" type="button" disabled={!chosen || busy !== null} onClick={prepare}>{busy === "prepare" ? "Turning on…" : prepared ? "Turn the workflows on again" : "Turn the offer's workflows on"}</button></div>
      {prepared ? <p className="note">{prepared.on.length} workflow{prepared.on.length === 1 ? "" : "s"} on, the company in <b>{d.company.mode}</b>, on {t.tests.contact?.name}; {ago(prepared.at)}.</p> : null}
      {prepared?.left_off.length ? <ul className="note">{prepared.left_off.map((w) => <li key={w.name}>{w.blocking ? <Tag kind="warn">blocks</Tag> : <Tag>off</Tag>} {w.name}: {w.why}</li>)}</ul> : null}
    </div>
    {prepared ? <div className="call" style={{ marginTop: 12 }}>
      <div className="hd"><b>Journeys</b><button className="btn" type="button" disabled={busy !== null} onClick={() => run(t.scenarios.map((s) => s.id))}>{busy && busy !== "prepare" ? "Running…" : "Run all"}</button></div>
      {t.scenarios.map((s) => { const r = t.tests.results?.[s.id]; return <div key={s.id} className="cal-row">
        <div className="hd"><b>{s.label}</b>{busy === s.id ? <Tag>running</Tag> : !r ? <Tag>not run</Tag> : r.passed ? <Tag kind="ok">clean</Tag> : <Tag kind="warn">problems</Tag>}
          <button className="btn" type="button" disabled={busy !== null} onClick={() => run([s.id])}>{r ? "Run again" : "Run"}</button></div>
        <p className="note">{s.about}{r ? ` · ${ago(r.at)} in ${r.rung}` : ""}</p>
        {r?.acts.filter((a) => !a.ok).map((a) => <div key={a.action} className="banner warn" style={{ marginTop: 0 }}>{a.action}: {a.why}</div>)}
        {r?.runs.length ? <ul className="note">{r.runs.map((x, i) => <li key={i}>{x.problem ? <Tag kind="warn">{x.status}</Tag> : <Tag kind="ok">{x.status}</Tag>} {x.workflow}{x.exit_reason ? ` (${x.exit_reason})` : ""}{x.problem ? `: ${x.problem}` : ""}</li>)}</ul>
          : r ? <p className="note">No run started.</p> : null}
      </div>; })}
    </div> : null}
    {prepared ? <div className="call" style={{ marginTop: 12 }}>
      <b>Workflows</b>
      {t.workflows.map((w) => <div key={w.name} className="cal-row">
        <div className="hd"><b>{w.name}</b><Tag kind={w.state === "clean" || w.state === "accepted" ? "ok" : "warn"}>{w.state}</Tag></div>
        {w.problems.length ? <ul className="note">{w.problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
        {w.state === "clean" ? <p className="note">{w.clean} clean run{w.clean === 1 ? "" : "s"}.</p> : null}
        {w.state === "accepted" ? <p className="note">Accepted: {w.note} <button className="btn" type="button" onClick={() => accept(w.name, "")}>Take back</button></p> : null}
        {w.state === "not reached" ? <div style={{ display: "flex", gap: 8 }}><input placeholder="How it was checked, or why it waits" value={notes[w.name] ?? ""} onChange={(e) => setNotes({ ...notes, [w.name]: e.target.value })} />
          <button className="btn" type="button" disabled={!(notes[w.name] ?? "").trim()} onClick={() => accept(w.name, notes[w.name])}>Accept</button></div> : null}
      </div>)}
    </div> : null}
    {prepared ? t.done ? <p className="note">Every workflow on is clean or accepted: the step is done.</p>
      : <Fold title={<>Left before this step is done · {t.todo.length}</>}><ul className="note">{t.todo.map((l) => <li key={l}>{l}</li>)}</ul></Fold> : null}
  </>;
}

/** One text or email, its words editable; `approvable` adds the onboarding approval (D155). Also the template business's words page (D156). */
export function MessageCard({ url, extra = {}, approvable, m, invalidate }: { url: string; extra?: Record<string, unknown>; approvable?: boolean; m: Message; invalidate: string[][] }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const post = useAction<Record<string, unknown>>((v) => api(url, { method: "POST", json: { ...extra, workflowId: m.workflowId, nodeId: m.nodeId, ...v } }), invalidate);
  const changed = m.fields.filter((f) => draft[f.field] !== undefined && draft[f.field] !== f.text);
  const save = async () => { setErr(null); try { for (const f of changed) await post.mutateAsync({ field: f.field, text: draft[f.field] }); setDraft({}); toast(approvable ? "Words saved: approve them when they read right." : "Words saved."); } catch (x) { setErr((x as Error).message); } };
  const approve = async () => { setErr(null); try { await post.mutateAsync({ approve: true }); toast(`Approved: ${m.title}.`); } catch (x) { setErr((x as Error).message); } };
  return <div className="cal-row">
    <div className="hd"><b>{m.channel === "sms" ? "Text" : "Email"}{["Text", "Email"].includes(m.title) ? "" : `: ${m.title}`}</b>
      {m.foreign.length ? <Tag kind="warn">another client's words</Tag> : m.placeholder ? <Tag kind="warn">placeholder</Tag> : !approvable ? null : m.approved ? <Tag kind="ok">approved</Tag> : <Tag>to approve</Tag>}</div>
    {m.foreign.length ? <div className="banner warn" style={{ marginTop: 0 }}>Carries {m.foreign.join(", ")}: change them{approvable ? " before it can be approved" : " before this can be published"}.</div> : null}
    {err ? <div className="banner warn" style={{ marginTop: 0 }}>{err}</div> : null}
    <div className="form">{m.fields.map((f) => <label key={f.field}><span>{f.label}</span>
      {f.field === "subject" ? <input value={draft[f.field] ?? f.text} onChange={(e) => setDraft({ ...draft, [f.field]: e.target.value })} />
        : <textarea rows={m.channel === "email" ? 8 : 3} value={draft[f.field] ?? f.text} onChange={(e) => setDraft({ ...draft, [f.field]: e.target.value })} />}</label>)}</div>
    <div style={{ display: "flex", gap: 8 }}>
      {changed.length ? <button className="btn" type="button" disabled={post.isPending} onClick={save}>Save the words</button> : null}
      {approvable && !m.approved && !changed.length ? <button className="btn" type="button" disabled={post.isPending || m.placeholder || m.foreign.length > 0} onClick={approve}>Approve as written</button> : null}
    </div>
  </div>;
}
