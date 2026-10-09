import { asOperator } from "@/db/client";
import { runPage } from "@/api/data";
import { fail, ok } from "@/api/http";
export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return asOperator(async (c) => { const page = await runPage(c, id); return page ? ok(page) : fail(404, "no such run"); });
}
