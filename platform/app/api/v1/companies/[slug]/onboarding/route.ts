import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { onboardingState, saveIntake } from "@/onboarding/store";
export const dynamic = "force-dynamic";

/** D143: the onboarding wizard of a client being stood up: its steps, what each saved, the intake's questions. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await asOperator((c) => onboardingState(c, slug));
  return s ? ok(s) : fail(404, "this company is not being onboarded");
}

/** { step: "offer", intake, playbook? } → the answers saved, the playbook and its fit report. Each later step is its own `step`. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await readJson<{ step?: string; intake?: unknown; playbook?: unknown }>(req);
  if (!body?.step) return fail(400, "step is required");
  return asOperator(async (c) => {
    const co = await companyBySlug(c, slug); if (!co) return fail(404, "no such company");
    if (body.step === "offer") {
      const r = await saveIntake(c, co.id, { intake: body.intake, playbook: body.playbook, by: "dashboard" });
      return r.ok ? ok({ ok: true, playbook: r.playbook, fit: r.fit }) : fail(r.status, r.why, r.problems ? { problems: r.problems } : {});
    }
    return fail(400, `no step "${body.step}" yet`);
  });
}
