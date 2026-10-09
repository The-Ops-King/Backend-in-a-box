import { asOperator } from "@/db/client";
import { companiesPage } from "@/api/data";
import { ok } from "@/api/http";
export const dynamic = "force-dynamic";
export async function GET() { return ok(await asOperator((c) => companiesPage(c))); }
