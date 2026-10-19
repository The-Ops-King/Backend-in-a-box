import { NextResponse } from "next/server";
import { asOperator } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { liveAdapters } from "@/adapters";
import { playbooks } from "@/playbooks";
import { runSandboxJourney, sandboxStatus, setupSandbox } from "@/playbooks/sandbox";
export const dynamic = "force-dynamic"; export const maxDuration = 300;   // setup reads and builds in GHL; a journey ticks between its steps

/**
 * D183, with Authorization: Bearer $CRON_SECRET: a playbook's template business tested in the sandbox (the snapshot sub-account,
 * from the deployment's SANDBOX_* settings), driven by Claude; not the onboarding wizard's.
 * GET  ?playbook=<slug> → each journey's latest result, each workflow's state, what publish still needs.
 * POST { playbook, action: "setup", answers? } → every step up to the test rung, stopping at the first that fails; `answers`
 *      overrides the calendar and team mapping made from the sandbox ({ calendars, closerCall, bookingCalendar, team }).
 * POST { playbook, action: "run", journey } → one journey on the test contact, its runs read back.
 */
const known = (p: unknown): p is string => typeof p === "string" && playbooks.some((x) => x.slug === p);

export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const playbook = new URL(req.url).searchParams.get("playbook");
  if (!known(playbook)) return NextResponse.json({ error: `playbook is one of ${playbooks.map((p) => p.slug).join(", ")}` }, { status: 400 });
  const s = await sandboxStatus(playbook);
  return s ? NextResponse.json({ ok: true, ...s }) : NextResponse.json({ error: "not set up yet: POST action setup" }, { status: 404 });
}

export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { playbook?: unknown; action?: unknown; journey?: unknown; answers?: unknown } | null;
  if (!known(body?.playbook)) return NextResponse.json({ error: `playbook is one of ${playbooks.map((p) => p.slug).join(", ")}` }, { status: 400 });
  if (body!.action === "setup") {
    const r = await setupSandbox(asOperator, liveAdapters, body!.playbook as string, { answers: body!.answers && typeof body!.answers === "object" ? body!.answers as never : undefined });
    return NextResponse.json(r, { status: r.ok ? 200 : 409 });
  }
  if (body!.action === "run") {
    if (typeof body!.journey !== "string") return NextResponse.json({ error: "journey is required (GET lists them)" }, { status: 400 });
    const r = await runSandboxJourney(asOperator, liveAdapters, body!.playbook as string, body!.journey);
    return r.ok ? NextResponse.json({ ok: true, result: r.result }) : NextResponse.json({ error: r.why }, { status: r.status });
  }
  return NextResponse.json({ error: "action is setup or run" }, { status: 400 });
}
