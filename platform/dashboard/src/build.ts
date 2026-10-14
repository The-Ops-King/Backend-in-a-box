import { useEffect, useState } from "react";

declare const __BUILD__: string;
/** D113: the deploy this bundle came from; the API answers with the deploy it runs ("x-build"). */
export const BUILD: string = typeof __BUILD__ === "string" ? __BUILD__ : "dev";

/** The API ran a later deploy than this bundle: both name one, and they differ (a local build says "dev" and is never stale). */
export const isNewer = (bundle: string, server: string | null): boolean => !!server && server !== "dev" && bundle !== "dev" && server !== bundle;

let newer = false;
export const newerDeployLive = () => newer;
const listeners = new Set<() => void>();
/** An open tab keeps running the code it loaded: once the API is a later deploy than this bundle, the page must not go on drawing with old code. */
export function noteServerBuild(server: string | null) {
  if (newer || !isNewer(BUILD, server)) return;
  newer = true;
  for (const l of listeners) l();
}
export function useNewerDeploy(): boolean {
  const [is, set] = useState(newer);
  useEffect(() => { const l = () => set(true); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return is;
}
