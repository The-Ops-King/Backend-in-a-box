import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, usePage, useAction, type OnboardingPage } from "~/api";
import { Crumb, Empty, Fold, Ic, NameLine, Sec, Skeleton, Tag, toast } from "~/ui/pieces";
import { ago } from "~/fmt";
import type { FitReport, Intake, IntakeField } from "@/onboarding/intake";
import type { StepId } from "@/onboarding/store";
import type { ConnectionRow } from "@/onboarding/connections";

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
          : at === "connections" ? <ConnectionsStep slug={slug} d={d} invalidate={key} /> : null}
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
