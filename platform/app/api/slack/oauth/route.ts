import { asOperator } from "@/db/client";
import { finishInstall, sharedSlackApp } from "@/engine/slack-app";
export const dynamic = "force-dynamic";

const page = (title: string, text: string, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
  { status, headers: { "content-type": "text/html; charset=utf-8" } });
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * D251: where Slack sends the person back after "Add to Slack" on an offer's install link. The code becomes that workspace's bot
 * token, kept as the offer's Slack (the link says which offer, signed, for an hour). A cancel or a stale link changes nothing.
 */
export async function GET(req: Request) {
  const app = sharedSlackApp();
  if (!app) return page("Slack app not set up", "The server does not have the shared Slack app's keys yet.", 503);
  const u = new URL(req.url), code = u.searchParams.get("code"), state = u.searchParams.get("state") ?? "";
  if (u.searchParams.get("error")) return page("Nothing was installed", `Slack said: ${esc(u.searchParams.get("error")!)}. Nothing changed.`, 400);
  if (!code) return page("Nothing was installed", "Slack did not send back a code. Use the install link again.", 400);
  const r = await asOperator((c) => finishInstall(c, { code, state, app }));
  if (!r.ok) return page("Nothing was installed", esc(r.why), 400);
  return page("Slack connected", `${esc(r.slug)} now posts and answers in ${esc(r.team)}.${r.replaced === "own" ? " Its old Slack app no longer answers; it can be removed from the workspace." : ""} You can close this tab.`);
}
