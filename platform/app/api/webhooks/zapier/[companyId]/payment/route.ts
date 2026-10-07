import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { loadCompany } from "@/engine/context";
import { recordPayment } from "@/engine/payments";
import { dispatchEvent } from "@/engine/dispatch";
import { parseZapierPayment } from "@/engine/webhooks/zapier";
import { notifyTeam } from "@/engine/notify";
import { zapierAuthorized } from "@/engine/inbound";
export const dynamic = "force-dynamic";

/**
 * Whop → Zapier → here. Authenticated with the company's inbound secret (install returns it) as `Authorization: Bearer`
 * or `x-engine-secret`. Body: the Zap's mapped fields; see parseZapierPayment for accepted names.
 */
export async function POST(req: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ error: "body is not JSON" }, { status: 400 }); }
  return asOperator(async (c) => {
    const { row: company, bindings } = await loadCompany(c, companyId);
    if (!zapierAuthorized(req, bindings)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const parsed = parseZapierPayment(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.why }, { status: 400 });
    const r = await recordPayment(c, companyId, parsed.input);
    if (r.outcome === "duplicate") return NextResponse.json({ ok: true, duplicate: true, payment: r.payment.id });
    if (r.outcome === "unlinked") {
      await notifyTeam(c, company, bindings, "alerts", `*Unlinked payment* · $${Math.abs(parsed.input.amount).toFixed(2)} ${parsed.input.status}\nNobody in the CRM matched this buyer.\n*Email:* ${parsed.input.email ?? "—"} · *Phone:* ${parsed.input.phone ?? "—"} · *Whop member:* ${parsed.input.memberId ?? "—"}\nLink it: ${process.env.TICK_URL ?? ""}/c/${company.slug}/payments`);
      return NextResponse.json({ ok: true, unlinked: true, payment: r.payment.id });
    }
    const started = await dispatchEvent(c, r.event, { contact: { id: r.contactId } });
    return NextResponse.json({ ok: true, event: r.event.id, kind: r.payment.kind, running_total: r.event.data.running_total, cleared: r.event.data.cleared, healed: r.healed, runs_started: started.length });
  });
}
