import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import { useNewerDeploy } from "./build";
import "./app.css";
import { Frame } from "./ui/frame";
import { Toasts } from "./ui/pieces";
import { Login } from "./pages/login";
import { Companies } from "./pages/companies";
import { Company } from "./pages/company";
import { Workflow } from "./pages/workflow";
import { Run } from "./pages/run";
import { Contact } from "./pages/contact";
import { Health } from "./pages/health";
import { EodList } from "./pages/eod-list";
import { Setup } from "./pages/setup";
import { WrapUps } from "./pages/wrapups";
import { Eod } from "./pages/eod";
import { Onboarding } from "./pages/onboarding";

/**
 * D113: a tab opened before a deploy keeps the old code (the old chart) until it reloads. Once the API is newer, the next
 * page change loads the new code, and until then a line at the top says so with a reload button.
 */
function NewerDeploy() {
  const newer = useNewerDeploy();
  const loc = useLocation();
  // the page they are on when it is noticed stays put; the next page they open loads the new code
  const at = useRef<string | null>(null);
  useEffect(() => { if (!newer) return; if (at.current === null) at.current = loc.key; else if (loc.key !== at.current) location.reload(); }, [newer, loc.key]);
  if (!newer) return null;
  return <div className="newer-deploy">A newer version of the dashboard is live. This page is still the old one. <button className="btn" onClick={() => location.reload()}>Reload</button></div>;
}

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <NewerDeploy />
        <Routes>
          <Route path="/eod/:token" element={<Eod />} />
          <Route path="/app/login" element={<Login />} />
          <Route path="/app" element={<Frame />}>
            <Route index element={<Companies />} />
            <Route path="c/:slug" element={<Company />} />
            <Route path="c/:slug/w/:id" element={<Workflow />} />
            <Route path="c/:slug/r/:id" element={<Run />} />
            <Route path="c/:slug/contacts/:id" element={<Contact />} />
            <Route path="c/:slug/health" element={<Health />} />
            <Route path="c/:slug/eod" element={<EodList />} />
            <Route path="c/:slug/setup" element={<Setup />} />
            <Route path="c/:slug/onboarding" element={<Onboarding />} />
            <Route path="c/:slug/wrap-ups" element={<WrapUps />} />
          </Route>
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </BrowserRouter>
      <Toasts />
    </QueryClientProvider>
  </React.StrictMode>,
);
