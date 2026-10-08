"use client";
import { useEffect, useRef } from "react";
import { KIND_FILL, STATUS_STROKE } from "@/engine/mermaid";
import { KIND_LABEL } from "@/engine/describe";

const LEGEND_KINDS = ["trigger", "message", "crm", "decision", "wait", "ai", "exit"] as const;
const LEGEND_STATUS: [string, string, string][] = [["ok", "ran", "solid"], ["waiting", "waiting here", "dashed"], ["failed", "failed", "solid"], ["stale", "skipped / stale", "dotted"]];

export function Mermaid({ chart, legend = true }: { chart: string; legend?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const m = (await import("mermaid")).default;
      await document.fonts?.ready;   // measure labels with the real font, or boxes are drawn too narrow and clip their words
      m.initialize({ startOnLoad: false, theme: "base", securityLevel: "loose", flowchart: { curve: "basis", nodeSpacing: 40, rankSpacing: 54, htmlLabels: false, padding: 14, wrappingWidth: 220 }, fontFamily: "Inter, system-ui, sans-serif",
        themeVariables: { background: "#0c0b0a", primaryColor: "#222120", primaryTextColor: "#f7f5f0", primaryBorderColor: "#b3ada3", lineColor: "#c4bfb6", secondaryColor: "#141312", tertiaryColor: "#141312", edgeLabelBackground: "#141312", fontSize: "15px", clusterBkg: "#141312" } });
      const { svg } = await m.render(`m${Math.random().toString(36).slice(2)}`, chart);
      if (alive && ref.current) ref.current.innerHTML = svg;
    })().catch((e) => { if (ref.current) ref.current.textContent = `diagram error: ${e.message}`; });
    return () => { alive = false; };
  }, [chart]);
  return (
    <div className="chart">
      <div ref={ref} className="chart-svg" />
      {legend && (
        <div className="legend">
          <div className="legend-group"><span className="legend-h">Shape and color = what the step is</span>
            {LEGEND_KINDS.map((k) => <span key={k} className="legend-item"><i className={`sw sw-${k === "trigger" ? "pill" : k === "decision" ? "diamond" : k === "wait" ? "bars" : k === "exit" ? "ring" : "box"}`} style={{ background: KIND_FILL[k].fill, borderColor: KIND_FILL[k].stroke }} />{KIND_LABEL[k]}</span>)}
          </div>
          <div className="legend-group"><span className="legend-h">Outline = what happened in this run</span>
            {LEGEND_STATUS.map(([k, t, dash]) => <span key={k} className="legend-item"><i className={`sw sw-box sw-${dash}`} style={{ borderColor: STATUS_STROKE[k], borderWidth: 3 }} />{t}</span>)}
            <span className="legend-item"><i className="sw sw-box" style={{ borderColor: STATUS_STROKE.here, borderWidth: 4 }} />current step</span>
          </div>
        </div>
      )}
    </div>
  );
}
