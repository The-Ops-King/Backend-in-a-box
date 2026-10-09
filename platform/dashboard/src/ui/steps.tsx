import { useState } from "react";
import type { PathItem } from "~/api";
import { Chev } from "./icons";
import { Ic } from "./pieces";
import { when } from "~/fmt";

/**
 * The step rows: the feed on a run page and the list in a run's sheet. A send carries "the words" folded; a skipped step
 * carries "why" folded; nothing blue or quoted is on the page until tapped (design guide §2.5).
 */
export function Steps({ items, tz, who }: { items: PathItem[]; tz: string; who?: string }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return <div className="steps">{items.map((s, i) => {
    const why = s.state === "skip" && s.note; const words = !!s.words; const has = !!(why || words);
    const o = !!open[i];
    const title = s.title + (s.meta ? ` · ${s.meta}` : "");
    const sub = s.state !== "skip" && s.note ? s.note : null;
    const at = s.at ? (s.state === "next" || s.state === "here" ? when(s.at, tz) : when(s.at, tz)) : s.state === "next" ? "when it is due" : "";
    return <div key={`${s.node_id}-${i}`} className={`s ${s.state} ${has ? "has" : ""} ${o ? "open" : ""}`} onClick={has ? () => setOpen((x) => ({ ...x, [i]: !x[i] })) : undefined} role={has ? "button" : undefined} tabIndex={has ? 0 : undefined} onKeyDown={has ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((x) => ({ ...x, [i]: !x[i] })); } } : undefined}>
      <Ic state={s.state} />
      <span className="t">{title}{at ? <span className="d">{at}</span> : null}{has ? <span className="pk"><Chev />{why ? "why" : "the words"}</span> : null}
        {sub ? <small>{sub}</small> : null}
        {why ? <small hidden={!o}>{s.note}</small> : null}
        {words ? <span className={`b ${s.channel ?? ""}`} hidden={!o}>{s.send_state === "failed" || s.send_state === "suppressed" ? <span style={{ display: "block", color: "var(--warn)", fontWeight: 600, marginBottom: 4 }}>{s.send_state === "failed" ? "Did not go out" : "Held back"}{s.note ? `: ${s.note}` : ""}</span> : null}{s.words}</span> : null}
      </span>
    </div>;
  })}{who ? null : null}</div>;
}
