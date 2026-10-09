import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { setupPage } from "@/api/setup";
import { fail, ok } from "@/api/http";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
  const page = await setupPage(co); if (!page) return fail(404, "no such company");
  return ok(page);
}
