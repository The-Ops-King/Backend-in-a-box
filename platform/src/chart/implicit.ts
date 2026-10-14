import type { Definition } from "@/engine/definition";
import { onwardEdge } from "@/engine/definition";
import { durationWords, exitWords } from "@/engine/describe";
import type { Chart, ChartEdge, ChartNode } from "@/api/words";

/**
 * D111: the ways a run leaves a step that are not edges of the definition, read off what executor.ts and runner.ts do, so
 * the chart draws them and the exactness check holds both layouts to them. Every one, with what decides it:
 * - check: its condition still false (after looking again for `retry.for`, when it retries) → the run stops with
 *   `else_exit`, or with `else_pause` it pauses for a person (the step fails and the runner pauses the run).
 * - branch with no otherwise way, when no way's condition holds → the step fails: the run pauses for a person.
 * - wait_for_reply with no "timeout" edge, when no reply comes in time → the run stops ("no_reply").
 * - send_sms / send_email with on_stale "escalate", when the message is out of date → the run pauses for a person.
 * - start_workflow → hands the person to that workflow and the run ends (its own edges are never taken).
 * - exit → the run ends (its edges are never taken).
 * - resume, after a non-blocking listener (wait_for_reaction, blocking false) pulled the run away → back to the step the
 *   run was parked on when the tap (or the listener's deadline) came: a wait, a send held for the send window, a step held
 *   on a vendor (D77), an exit the run reached with the listener still armed; any step from the listener's onward way on.
 *   Drawn as one line to the first step of that stretch, its words saying "or one after it".
 * Never drawn because never stored: a step with no way on (the runner would fail the run) and an event wait with no way
 * for one of its outcomes; definition.ts refuses both. Not lines: a check's `retry` stays on the step (its words say how
 * long); a send skipped as stale, out of its validity or with SMS off, an `only_if` skip, a Slack post with nothing to post to all go on along the normal edge; a step a vendor
 * refuses is retried, then holds or pauses the run (D66/D77) wherever the run is, as do the run-wide rules (the premise
 * check and a contact gone from the CRM end the run moot before any step): none of them is a way out of one step.
 */
type Extra = { nodes: ChartNode[]; edges: ChartEdge[]; drop: (e: { from: string }) => boolean; relabel: Map<number, string>; replace: Map<number, ChartEdge> };

export function withImplicit(def: Definition, chart: Chart): Chart {
  const x = implicitOf(def, chart);
  const edges = chart.edges.flatMap((e, i) => x.drop(def.edges[i]) ? [] : [x.replace.get(i) ?? (x.relabel.has(i) ? { ...e, label: x.relabel.get(i)! } : e)]);
  return { nodes: [...chart.nodes, ...x.nodes], edges: [...edges, ...x.edges] };
}

function implicitOf(def: Definition, chart: Chart): Extra {
  const out: Extra = { nodes: [], edges: [], drop: () => false, relabel: new Map(), replace: new Map() };
  const from = (id: string) => def.edges.filter((e) => e.from === id);
  const title = (id: string) => chart.nodes.find((n) => n.id === id)?.title ?? id;
  const end = (at: string, kind: "stop" | "pause" | "handoff", words: string, detail: string): string => {
    const id = `${at}~${kind}`;
    if (!out.nodes.some((n) => n.id === id)) out.nodes.push({ id, kind: "end", title: words, detail, logo: "end" });
    return id;
  };
  const line = (fromId: string, to: string, label: string, otherwise = false) => out.edges.push({ from: fromId, to, label, ...(otherwise ? { else: true } : {}) });
  const ends = new Set(def.nodes.filter((n) => n.type === "exit" || n.type === "start_workflow").map((n) => n.id));
  out.drop = (e) => ends.has(e.from);

  for (const n of def.nodes) {
    const edges = from(n.id);
    switch (n.type) {
      case "check": {
        const label = n.retry ? `otherwise, after looking for up to ${durationWords(n.retry.for)}` : "otherwise";
        if (n.else_pause) { line(n.id, end(n.id, "pause", `Paused for a person: ${n.else_pause}`, "The run pauses here until a person retries or skips the step on the run page."), label, true); break; }
        // its own end, in the exit's words; an exit step of the same reason that nothing leads to is never run (and not drawn)
        line(n.id, end(n.id, "stop", exitWords(n.else_exit), "The run ends here."), label, true);
        break;
      }
      case "branch":
        if (edges.length && !edges.some((e) => e.else)) line(n.id, end(n.id, "pause", "Paused for a person: no way matched", "None of the ways' conditions held and there is no otherwise way: the step fails and the run pauses for a person."), "none of these", true);
        break;
      case "wait_for_reply":
        if (!edges.some((e) => e.label === "timeout")) line(n.id, end(n.id, "stop", exitWords("no_reply"), "No reply came in time: the run ends here."), "no reply in time");
        break;
      case "send_sms": case "send_email":
        if (n.on_stale === "escalate") line(n.id, end(n.id, "pause", "Paused for a person: the message is out of date", "The message would say something no longer true: it is not sent and the run pauses for a person."), "out of date");
        break;
      case "start_workflow":
        line(n.id, end(n.id, "handoff", `Hands off to “${n.workflow}”`, `The person is started on “${n.workflow}” and this run ends (if that workflow is off or will not take them again, the run ends all the same).`), "");
        break;
    }
  }

  // resume: back to where a non-blocking listener pulled the run from
  const reach = (start: string, follow: (id: string) => string[]) => { const seen = new Set<string>(); const q = [start]; while (q.length) { const id = q.shift()!; if (seen.has(id)) continue; seen.add(id); q.push(...follow(id)); } return seen; };
  const all = (id: string) => from(id).map((e) => e.to);
  for (const l of def.nodes) {
    if (l.type !== "wait_for_reaction" || l.blocking) continue;
    const onward = onwardEdge(from(l.id))?.to; if (!onward) continue;
    const pulled = from(l.id).filter((e) => e.label === "tap" || e.label === "until").flatMap((e) => [...reach(e.to, (id) => def.nodes.find((m) => m.id === id)?.type === "resume" ? [] : all(id))]);
    for (const r of def.nodes.filter((m) => m.type === "resume" && pulled.includes(m.id))) {
      const label = `back to the step the run was on: “${title(onward)}” or one after it`;
      const plain = def.edges.findIndex((e) => e.from === r.id && e.to === onward);
      // nothing pulled the run away: the step goes on to that same first step, which the words already cover
      if (plain >= 0) out.replace.set(plain, { from: r.id, to: onward, label });
      else { line(r.id, onward, label); const i = def.edges.findIndex((e) => e.from === r.id); if (i >= 0 && !def.edges[i].label) out.relabel.set(i, "nothing pulled the run away"); }
    }
  }
  return out;
}
