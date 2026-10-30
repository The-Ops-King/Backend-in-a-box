"use client";
import { useEffect, useState } from "react";
import { ROLES, sectionShows, type Block, type Guide, type Role, type Video } from "@/team-guide/types";
import { embedUrl } from "@/team-guide/embed";
import s from "./guide.module.css";

// the role is in the link (?role=setter), so a manager can send each person the page already showing their part
const readRole = (): Role | null => {
  const r = new URLSearchParams(window.location.search).get("role");
  return ROLES.some((x) => x.id === r) ? (r as Role) : null;
};

export function GuideView({ guide }: { guide: Guide }) {
  const [role, setRole] = useState<Role>("closer");
  useEffect(() => { const r = readRole(); if (r) setRole(r); }, []);
  const pick = (r: Role) => {
    setRole(r);
    const u = new URL(window.location.href); u.searchParams.set("role", r); u.hash = "";
    window.history.replaceState(null, "", u);
  };
  const parts = guide.parts.map((p) => ({ ...p, sections: p.sections.filter((x) => sectionShows(x, role)) })).filter((p) => p.sections.length);

  return <div className={s.page} style={{ "--brand": guide.brand.accent } as React.CSSProperties}>
    <header className={s.top}>
      <div className={s.topIn}>
        {guide.brand.logoUrl ? <img className={s.logo} src={guide.brand.logoUrl} alt={guide.brand.name} /> : <span className={s.mark}>{guide.brand.name}</span>}
        <span className={s.kicker}>Team onboarding</span>
      </div>
    </header>
    <main className={s.wrap}>
      <h1 className={s.h1}>{guide.title}</h1>
      <p className={s.intro}>{guide.intro}</p>
      <div className={s.roles} role="tablist" aria-label="Your role">
        {ROLES.map((r) => <button key={r.id} role="tab" aria-selected={role === r.id} className={role === r.id ? `${s.role} ${s.on}` : s.role} onClick={() => pick(r.id)}>{r.label}</button>)}
      </div>
      <p className={s.roleAbout}>{ROLES.find((r) => r.id === role)!.about}</p>

      <nav className={s.toc} aria-label="Contents">
        {parts.map((p, i) => <div key={p.id}>
          <a className={s.tocPart} href={`#${p.id}`}>{i + 1}. {p.title}</a>
          <ol>{p.sections.map((x) => <li key={x.id}><a href={`#${x.id}`}>{x.title}</a></li>)}</ol>
        </div>)}
      </nav>

      {parts.map((p, i) => <section key={p.id} id={p.id} className={s.part}>
        <h2 className={s.h2}><span>{i + 1}</span>{p.title}</h2>
        {p.sections.map((x) => <article key={x.id} id={x.id} className={s.card}>
          <div className={s.cardHd}>
            <h3 className={s.h3}>{x.title}</h3>
            {x.for.length < ROLES.length ? <span className={s.tags}>{x.for.map((r) => <span key={r} className={s.tag}>{ROLES.find((y) => y.id === r)!.label}</span>)}</span> : null}
          </div>
          <p className={s.summary}>{x.summary}</p>
          {x.blocks.map((b, j) => <BlockView key={j} b={b} />)}
        </article>)}
      </section>)}
      <p className={s.foot}>Stuck on something here? Type <code>/support</code> in Slack and say what you were trying to do.</p>
    </main>
  </div>;
}

function BlockView({ b }: { b: Block }) {
  if ("p" in b) return <p className={s.p}>{b.p}</p>;
  if ("list" in b) return <ul className={s.list}>{b.list.map((t, i) => <li key={i}>{t}</li>)}</ul>;
  if ("steps" in b) return <ol className={s.steps}>{b.steps.map((t, i) => <li key={i}><span>{i + 1}</span><div>{t}</div></li>)}</ol>;
  if ("rows" in b) return <div className={s.tbl}><table>
    {b.head ? <thead><tr><th>{b.head[0]}</th><th>{b.head[1]}</th></tr></thead> : null}
    <tbody>{b.rows.map(([k, v], i) => <tr key={i}><td>{k}</td><td>{v}</td></tr>)}</tbody>
  </table></div>;
  if ("note" in b) return <p className={b.tone === "important" ? `${s.note} ${s.important}` : s.note}>{b.note}</p>;
  return <VideoView v={b.video} />;
}

function VideoView({ v }: { v: Video }) {
  const src = v.url ? embedUrl(v.url) : null;
  if (!v.url) return <div className={s.videoSoon}><b>Video: {v.title}</b><span>Coming soon</span></div>;
  if (!src) return <p className={s.p}><a href={v.url} target="_blank" rel="noreferrer">Watch: {v.title}</a></p>;
  return <figure className={s.video}><iframe src={src} title={v.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen loading="lazy" /><figcaption>{v.title}</figcaption></figure>;
}
