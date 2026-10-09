import { asOperator, many } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok } from "@/api/http";
import { companyReports, tokenFor, totalsLine } from "@/engine/eod";
export const dynamic = "force-dynamic";
/** Filed end-of-day reports and every closer's standing link. */
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const reports = (await companyReports(c, co.id)).map((r) => ({ id: r.id, day: r.day, closer: r.closer, submitted_at: r.submitted_at, reminded_at: r.reminded_at, totals: r.answers ? totalsLine({ ...r.answers, deposits: r.answers.deposits ?? 0, cash: Number(r.answers.cash), revenue: Number(r.answers.revenue) }) : null, changes: r.changes ?? [] }));
    const us = await many<{ id: string; name: string; email: string }>(c, "select id, name, email from users where company_id=$1 and active and role='closer' order by name", [co.id]);
    const closers = []; for (const u of us) closers.push({ ...u, url: `${base}/eod/${await tokenFor(c, u.id)}` });
    return ok({ company: co, reports, closers });
  });
}
