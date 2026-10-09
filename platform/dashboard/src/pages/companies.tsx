import { Link } from "react-router-dom";
import { usePage, type CompaniesPage } from "~/api";
import { Counts, Empty, NameLine, Sec, Skeleton, Tag } from "~/ui/pieces";
import { ago } from "~/fmt";

export function Companies() {
  const q = usePage<CompaniesPage>(["companies"], "/api/v1/companies");
  if (!q.data) return q.error ? <p className="note">{q.error.message}</p> : <Skeleton />;
  const { engine, companies } = q.data;
  const stale = engine.last_tick ? (Date.now() - new Date(engine.last_tick).getTime()) / 60e3 > 5 : true;
  return <>
    <NameLine name="Companies" />
    <div className="tagline">{stale ? <Tag kind="warn">engine stale</Tag> : <Tag kind="ok">engine ticking</Tag>}<span>last tick {engine.last_tick ? ago(engine.last_tick) : "never"}{engine.recovery ? " · recovering" : ""}</span></div>
    {engine.problems.length ? <><Sec>Needs a look</Sec><div>{engine.problems.map((p) => <div key={p.key} className="issue"><Tag kind={p.level === "error" ? "warn" : ""}>{p.level}</Tag><span>{p.text}</span></div>)}</div></> : null}
    <Sec>Every company</Sec>
    {companies.length === 0 ? <Empty>No companies yet. Install one with the admin API.</Empty> : <div className="rows">{companies.map((c) => <Link key={c.id} to={`/app/c/${c.slug}`} className="row noicon">
      <span className="mid"><span className="nm">{c.name}</span><span className="sub"><Tag kind={c.mode}>{c.mode}</Tag>{c.alerts ? <Tag kind="warn">{c.alerts} open</Tag> : null}<span>{c.on} of {c.workflows} on</span><span>last poll {c.last_poll ? ago(c.last_poll) : "never"}</span></span></span>
      <Counts people={c.contacts} in_flight={c.in_flight} failed={c.failed_24h} />
    </Link>)}</div>}
  </>;
}
