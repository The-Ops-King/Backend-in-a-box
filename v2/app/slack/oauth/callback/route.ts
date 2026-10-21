import { defaultSlackApp } from "@/slack/default";
import { InstallError, completeInstall } from "@/slack/oauth";

export const dynamic = "force-dynamic";

/** GET /slack/oauth/callback?code=…&state=…: where Slack sends the installer back. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const text = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const r = await completeInstall(defaultSlackApp(), { code: q.get("code"), state: q.get("state"), error: q.get("error") });
    return text(`Slack is connected${r.teamName ? ` (${r.teamName})` : ""}. You can close this tab; the channels are picked in the offer's onboarding.`);
  } catch (e) {
    if (e instanceof InstallError) return text(e.message, 400);
    console.error("slack install failed", e);
    return text("The install did not complete. Tyler has the error in the logs.", 502);
  }
}
