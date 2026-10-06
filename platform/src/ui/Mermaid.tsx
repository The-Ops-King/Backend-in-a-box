"use client";
import { useEffect, useRef } from "react";
export function Mermaid({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const m = (await import("mermaid")).default;
      m.initialize({ startOnLoad: false, theme: "neutral", flowchart: { curve: "basis", nodeSpacing: 30, rankSpacing: 40 }, fontFamily: "Inter, system-ui, sans-serif" });
      const { svg } = await m.render(`m${Math.random().toString(36).slice(2)}`, chart);
      if (alive && ref.current) ref.current.innerHTML = svg;
    })().catch((e) => { if (ref.current) ref.current.textContent = `diagram error: ${e.message}`; });
    return () => { alive = false; };
  }, [chart]);
  return <div ref={ref} className="card" style={{ overflowX: "auto", padding: 12 }} />;
}
