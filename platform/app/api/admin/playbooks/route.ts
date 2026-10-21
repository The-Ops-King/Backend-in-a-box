import { NextResponse } from "next/server";
import { asOperator, one } from "@/db/client";
import { operatorAuthorized } from "@/engine/admin-auth";
import { playbooks } from "@/playbooks";
import { applyPlaybook, copyOfferSettings, playbookState, rungPlan, type ApplyResult, type CopySettingsResult } from "@/playbooks/apply";
export const dynamic = "force-dynamic"; export const maxDuration = 120;

/**
 * D170, with Authorization: Bearer $CRON_SECRET.
 * GET  → { playbooks: [{ slug, name, about, traits }] }; ?company=<slug> → also its playbook as last applied, the copies that fell
 *      behind today's templates (`stale`), and every workflow's starting rung (#48).
 * POST { company, playbook, params?, workflow?, copySettingsFrom?, apply?, by? } → the company's copies built by the playbook and
 *      saved (all or nothing; nothing is removed), after the offer settings of `copySettingsFrom` are copied where the company has
 *      none of its own. One transaction: when the playbook is refused, the settings copy is undone too.
 *      D208: a dry run unless `apply: true` (`dryRun` is no longer read). Every copy at once only on a company being onboarded or a
 *      template business; on a running offer a write names one `workflow` (its params the ones the company keeps, when none are given).
 */
export async function GET(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const list = playbooks.map((p) => ({ slug: p.slug, name: p.name, about: p.about, traits: p.traits }));
  const slug = new URL(req.url).searchParams.get("company");
  if (!slug) return NextResponse.json({ ok: true, playbooks: list });
  return asOperator(async (c) => {
    const co = await one<{ id: string }>(c, "select id from companies where slug=$1", [slug]);
    if (!co) return NextResponse.json({ error: "company not found" }, { status: 404 });
    return NextResponse.json({ ok: true, playbooks: list, company: slug, ...(await playbookState(c, co.id, slug)), rungs: await rungPlan(c, co.id) });
  });
}

class Refused extends Error { constructor(readonly out: { settings?: CopySettingsResult; playbook?: ApplyResult; status: number }) { super("refused"); } }

export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { company?: string; playbook?: string; params?: unknown; workflow?: string; copySettingsFrom?: string; apply?: boolean; by?: string } | null;
  if (!body?.company || !body.playbook) return NextResponse.json({ error: "company and playbook are required" }, { status: 400 });
  const dryRun = body.apply !== true;
  try {
    const out = await asOperator(async (c) => {
      let settings: CopySettingsResult | undefined;
      if (body.copySettingsFrom) {
        settings = await copyOfferSettings(c, { from: body.copySettingsFrom, to: body.company!, dryRun, by: body.by });
        if (!settings.ok) throw new Refused({ settings, status: settings.status });
      }
      const playbook = await applyPlaybook(c, { company: body.company!, playbook: body.playbook!, params: body.params, ...(body.workflow ? { workflow: body.workflow } : {}), dryRun, by: body.by });
      if (!playbook.ok) throw new Refused({ settings, playbook, status: playbook.status });
      return { settings, playbook };
    });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    if (e instanceof Refused) return NextResponse.json({ ok: false, ...(e.out.settings ? { settings: e.out.settings } : {}), ...(e.out.playbook ? { playbook: e.out.playbook } : {}) }, { status: e.out.status });
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 });
  }
}
