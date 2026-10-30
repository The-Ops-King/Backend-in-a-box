import { asOperator, many } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok } from "@/api/http";
import { companyReports, tokenFor, totalsLine } from "@/engine/eod";
import { loadCompany } from "@/engine/context";
import { missingEods } from "@/engine/missing-eods";
export const dynamic = "force-dynamic";
/** Filed end-of-day reports, every closer's and setter's standing link (D191: setters file their calls too), and who owes a day (D246). */
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const base = (process.env.PUBLIC_URL ?? process.env.TICK_URL ?? "").replace(/\/$/, "");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    const reports = (await companyReports(c, co.id)).map((r) => ({ id: r.id, day: r.day, closer: r.closer, submitted_at: r.submitted_at, reminded_at: r.reminded_at, totals: r.answers ? totalsLine({ ...r.answers, deposits: r.answers.deposits ?? 0, cash: Number(r.answers.cash), revenue: Number(r.answers.revenue) }) : null, changes: r.changes ?? [] }));
    const us = await many<{ id: string; name: string; email: string; role: string }>(c, "select id, name, email, role from users where company_id=$1 and active and role in ('closer','setter') order by role, name", [co.id]);
    const closers = []; for (const u of us) closers.push({ ...u, url: `${base}/eod/${await tokenFor(c, u.id)}` });
    // the operator's own page: each owed day opens that person's form on that day (their private link, never posted anywhere)
    const missing = []; for (const p of await missingEods(c, (await loadCompany(c, co.id)).row)) { const t = p.user_id ? await tokenFor(c, p.user_id) : null; missing.push({ name: p.name, role: p.role, days: p.days.map((d) => ({ ...d, url: t ? `${base}/eod/${t}?day=${d.day}` : null })), today: p.today }); }
    return ok({ company: co, reports, closers, missing });
  });
}
