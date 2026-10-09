import { asOperator } from "@/db/client";
import { companyBySlug, companyPage } from "@/api/data";
import { fail, ok } from "@/api/http";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return asOperator(async (c) => { const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company"); return ok(await companyPage(c, co)); });
}
