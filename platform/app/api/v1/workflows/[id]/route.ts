import { asOperator, one } from "@/db/client";
import { companyById, workflowPage } from "@/api/data";
import { fail, ok } from "@/api/http";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asOperator(async (c) => {
    const w = await one<{ company_id: string }>(c, "select company_id from workflows where id=$1", [id]); if (!w) return fail(404, "no such workflow");
    const co = (await companyById(c, w.company_id))!;
    const page = await workflowPage(c, co, id); return page ? ok(page) : fail(404, "no such workflow");
  });
}
