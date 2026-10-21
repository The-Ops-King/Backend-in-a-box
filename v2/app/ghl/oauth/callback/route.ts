import { connectLocation } from "@/ghl/oauth";
import { resumeLocation } from "@/connectors/ghl/auth";
import { defaultHub } from "@/connectors/runtime";

export const dynamic = "force-dynamic";

/** GET /ghl/oauth/callback?code=…: where GHL sends the installer after they approve the app on a sub-account. */
export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return new Response("No code from GHL.", { status: 400 });
  try {
    const { locationId } = await connectLocation(code);
    // a reinstall: the location's offers that were waiting on it go again
    await resumeLocation(defaultHub(), locationId);
    return new Response(`Connected GHL location ${locationId}. You can close this tab.`, { headers: { "content-type": "text/plain" } });
  } catch (e) {
    console.error("ghl install failed", e);
    return new Response("The install did not complete. Tyler has the error in the logs.", { status: 502 });
  }
}
