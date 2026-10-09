import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
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
            <Route path="c/:slug/wrap-ups" element={<WrapUps />} />
          </Route>
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </BrowserRouter>
      <Toasts />
    </QueryClientProvider>
  </React.StrictMode>,
);
