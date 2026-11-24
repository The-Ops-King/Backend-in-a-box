import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { parseZoomEvent, urlValidationAnswer, zoomSignatureOk } from "@/engine/webhooks/zoom";
import { meetingEnded, recordZoomEvent } from "@/engine/zoom";
import { respondAndRun } from "@/api/run-soon";
export const dynamic = "force-dynamic"; export const maxDuration = 60;

/**
 * D365: an offer's Zoom "Webhook only" app (secret.zoom_webhook, the app's Secret Token). Answers Zoom's URL validation; keeps
 * every participant joined / left once (Zoom retries); on meeting ended, gives the booking it was for its verdict
 * (`zoom.meeting_ended`: held, no_show or unclear). A request Zoom did not sign is refused.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) return NextResponse.json({ error: "no such offer" }, { status: 404 });
  const raw = await req.text();
  return asOperator(async (c) => {
    const { bindings } = await loadCompany(c, companyId);
    const secret = bindings["secret.zoom_webhook"];
    if (!secret) return NextResponse.json({ error: "zoom webhook secret not bound for this offer" }, { status: 503 });
    if (!zoomSignatureOk(secret, raw, req.headers.get("x-zm-request-timestamp"), req.headers.get("x-zm-signature"))) return NextResponse.json({ error: "bad signature" }, { status: 401 });
    let body: Parameters<typeof parseZoomEvent>[0] & { payload?: { plainToken?: string } };
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
    if (body.event === "endpoint.url_validation" && body.payload?.plainToken) return NextResponse.json(urlValidationAnswer(secret, body.payload.plainToken));
    const parsed = parseZoomEvent(body);
    if (!parsed.ok) return NextResponse.json({ ok: true, ignored: parsed.why });
    const first = await recordZoomEvent(c, companyId, parsed.event);
    if (!first) return NextResponse.json({ ok: true, duplicate: true });
    if (parsed.event.kind !== "ended") return NextResponse.json({ ok: true });
    return respondAndRun(companyId, { ok: true, ...(await meetingEnded(c, companyId, parsed.event)) });
  });
}
