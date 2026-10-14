// The chart alone, as the workflow page draws it, for scripts/render-charts.ts: the chart JSON is handed in on window.
import { createRoot } from "react-dom/client";
import "../src/app.css";
import { FlowChart, Legend } from "../src/ui/chart";
import type { Chart, PathItem } from "../src/api";

type Shot = { title: string; chart: Chart; states?: Record<string, PathItem["state"]>; pathOnly?: boolean };
const shot = (window as unknown as { __shot: Shot }).__shot;
createRoot(document.getElementById("root")!).render(<div className="wrap"><h3 style={{ margin: "6px 0 10px" }}>{shot.title}</h3><FlowChart chart={shot.chart} states={shot.states} pathOnly={shot.pathOnly} /><Legend run={!!shot.states} states={shot.states ? Object.values(shot.states) : undefined} /></div>);
