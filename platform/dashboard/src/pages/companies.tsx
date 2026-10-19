import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, usePage, useAction, type CompaniesPage } from "~/api";
import { Counts, Empty, NameLine, Sec, Skeleton, Tag } from "~/ui/pieces";
import { ago } from "~/fmt";
import { Templates } from "./templates";

export function Companies() {
  const q = usePage<CompaniesPage>(["companies"], "/api/v1/companies");
  const [adding, setAdding] = useState(false);
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton />;
  const { engine, companies } = q.data;
  const stale = engine.last_tick ? (Date.now() - new Date(engine.last_tick).getTime()) / 60e3 > 5 : true;
  const href = (c: CompaniesPage["companies"][number]) => c.status === "onboarding" ? `/app/c/${c.slug}/onboarding` : `/app/c/${c.slug}`;
  return <>
    <NameLine name="Companies" control={adding ? null : <button type="button" className="btn" onClick={() => setAdding(true)}>Add client</button>} />
    <div className="tagline">{stale ? <Tag kind="warn">engine stale</Tag> : <Tag kind="ok">engine ticking</Tag>}<span>last tick {engine.last_tick ? ago(engine.last_tick) : "never"}{engine.recovery ? " · recovering" : ""}</span></div>
    {adding ? <AddClient onCancel={() => setAdding(false)} /> : null}
    {engine.problems.length ? <><Sec>Needs a look</Sec><div>{engine.problems.map((p) => <div key={p.key} className="issue"><Tag kind={p.level === "error" ? "warn" : ""}>{p.level}</Tag><span>{p.text}</span></div>)}</div></> : null}
    <Sec>Every company</Sec>
    {companies.filter((c) => c.status !== "template").length === 0 ? <Empty>No companies yet. Add client starts one.</Empty> : <div className="rows">{companies.filter((c) => c.status !== "template").map((c) => <Link key={c.id} to={href(c)} className="row noicon">
      <span className="mid"><span className="nm">{c.name}</span><span className="sub">{c.status === "onboarding" ? <Tag kind="warn">onboarding</Tag> : null}<Tag kind={c.mode}>{c.mode}</Tag>{c.alerts ? <Tag kind="warn">{c.alerts} open</Tag> : null}<span>{c.on} of {c.workflows} on</span><span>last poll {c.last_poll ? ago(c.last_poll) : "never"}</span>{c.last_tick ? <span>ticked {ago(c.last_tick)}{c.tick_ms != null ? ` in ${(c.tick_ms / 1000).toFixed(1)} s` : ""}</span> : null}</span></span>
      <Counts people={c.contacts} in_flight={c.in_flight} needs_hand={c.needs_hand} />
    </Link>)}</div>}
    <Templates />
  </>;
}

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "Europe/London", "Australia/Sydney"];

/** D171: a client starts as a name, a time zone, and whether it is a new offer or a running system taken over. */
function AddClient({ onCancel }: { onCancel: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState(""); const [timezone, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [kind, setKind] = useState<"new" | "takeover">("new"); const [err, setErr] = useState<string | null>(null);
  const add = useAction<{ name: string; timezone: string; kind: string }, { href: string }>((v) => api("/api/v1/companies", { method: "POST", json: v }), [["companies"]]);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setErr(null); try { nav((await add.mutateAsync({ name, timezone, kind })).href); } catch (x) { setErr((x as Error).message); } };
  return <form className="form call addclient" onSubmit={submit}>
    <b>Add client</b>
    {err ? <div className="banner warn" style={{ marginTop: 0 }}><strong>Not added.</strong> {err}</div> : null}
    <div className="g2">
      <label>Offer name<span className="note"> · as the dashboard shows it, e.g. PMU</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Time zone<input list="zones" value={timezone} onChange={(e) => setTz(e.target.value)} required /><datalist id="zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist></label>
      <label className="wide">What is it?<select value={kind} onChange={(e) => setKind(e.target.value as "new" | "takeover")}><option value="new">A new offer: built fresh on our stack</option><option value="takeover">A takeover: a running system with live calls and automations</option></select></label>
    </div>
    <div style={{ display: "flex", gap: 8 }}><button className="btn" type="submit" disabled={add.isPending}>{add.isPending ? "Adding…" : "Add and start onboarding"}</button><button className="btn" type="button" onClick={onCancel}>Cancel</button></div>
    <p className="note">Nothing runs for it yet: the engine starts on it at the install step, in ghost.</p>
  </form>;
}
