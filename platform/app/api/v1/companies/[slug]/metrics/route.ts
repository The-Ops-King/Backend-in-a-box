import { asOperator } from "@/db/client";
import { companyBySlug, metricsPage } from "@/api/data";
import { fail, ok } from "@/api/http";
export const dynamic = "force-dynamic";
/** Setter metrics over ?from=&to= (inclusive local dates; default this week so far). */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const sp = new URL(req.url).searchParams;
  const from = sp.get("from"), to = sp.get("to");
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) return fail(400, "from and to are YYYY-MM-DD");
  if (from && to && from > to) return fail(400, "from is after to");
  return asOperator(async (c) => { const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company"); return ok(await metricsPage(c, co, from, to)); });
}
