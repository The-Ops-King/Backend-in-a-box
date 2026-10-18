import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { onboardingState, saveIntake } from "@/onboarding/store";
import { connect } from "@/onboarding/connections";
export const dynamic = "force-dynamic";

/** D143: the onboarding wizard of a client being stood up: its steps, what each saved, the intake's questions. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await asOperator((c) => onboardingState(c, slug));
  return s ? ok(s) : fail(404, "this company is not being onboarded");
}

/**
 * { step: "offer", intake, playbook? } → the answers saved, the playbook and its fit report.
 * { step: "connection", id, values? | copyFrom? } (D144) → the key tested live; kept, encrypted, only when it works. With
 * neither, the kept key is tested again. The answer never carries a key.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await readJson<{ step?: string; intake?: unknown; playbook?: unknown; id?: unknown; values?: unknown; copyFrom?: unknown }>(req);
  if (!body?.step) return fail(400, "step is required");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    if (body.step === "offer") {
      const r = await saveIntake(c, co.id, { intake: body.intake, playbook: body.playbook, by: "dashboard" });
      return r.ok ? ok({ ok: true, playbook: r.playbook, fit: r.fit }) : fail(r.status, r.why, r.problems ? { problems: r.problems } : {});
    }
    if (body.step === "connection") {
      const r = await connect(c, co.id, { id: body.id, values: body.values, copyFrom: body.copyFrom, by: "dashboard" });
      return r.ok ? ok({ ok: true, check: r.check }) : fail(r.status, r.why, r.check ? { check: r.check } : {});
    }
    return fail(400, `no step "${body.step}" yet`);
  });
}
