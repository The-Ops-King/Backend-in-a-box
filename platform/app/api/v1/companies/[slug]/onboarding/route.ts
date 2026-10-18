import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { onboardingState, saveIntake } from "@/onboarding/store";
import { connect } from "@/onboarding/connections";
import { gather, researchInput, saveResearch, saveResearchAnswers } from "@/onboarding/research";
import { connectSlack, saveChannels, saveSlackOptions } from "@/onboarding/slack";
import { crmInput, runCrm, saveCrm, saveCrmOptions } from "@/onboarding/crm";
export const dynamic = "force-dynamic"; export const maxDuration = 180;   // research reads their accounts and asks the model

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
 * { step: "research" } (D145) → their accounts read and the AI's suggestions, saved (outside any transaction while it reads);
 * { step: "research", answers } → Tyler's answers checked and saved; done when nothing is left to answer.
 * { step: "slack", options | token + signingSecret | channels } (D146) → the manifest's options; the bot token tested with Slack
 * and kept with the signing secret; each channel slot's channel. GET …/onboarding/slack says where it stands.
 * { step: "crm", options } (D147) → the prefix; { step: "crm", run: "plan" | "build" } → their GHL read and what the playbook
 * needs planned (reads only), or built (only what is missing), outside any transaction while GHL is called.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await readJson<{ step?: string; intake?: unknown; playbook?: unknown; id?: unknown; values?: unknown; copyFrom?: unknown; answers?: unknown; options?: unknown; token?: unknown; signingSecret?: unknown; channels?: unknown; run?: unknown }>(req);
  if (!body?.step) return fail(400, "step is required");
  if (body.step === "crm" && (body.run === "plan" || body.run === "build")) {
    const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
    const input = await asOperator((c) => crmInput(c, co.id));
    if (!input.ok) return fail(input.status, input.why);
    const r = await runCrm(input.input, body.run === "build");
    await asOperator((c) => saveCrm(c, co.id, r));
    return r.error ? fail(502, `GHL: ${r.error}`, { crm: r }) : ok({ ok: true, crm: r });
  }
  if (body.step === "research" && body.answers === undefined) {
    const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
    const input = await asOperator((c) => researchInput(c, co.id));
    if (!input.ok) return fail(input.status, input.why);
    const r = await gather(input.input);
    await asOperator((c) => saveResearch(c, co.id, r));
    return ok({ ok: true, research: r });
  }
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
    if (body.step === "slack") {
      const r = body.options !== undefined ? await saveSlackOptions(c, co.id, body.options)
        : body.token !== undefined ? await connectSlack(c, co.id, { token: body.token, signingSecret: body.signingSecret, by: "dashboard" })
        : body.channels !== undefined ? await saveChannels(c, co.id, body.channels, "dashboard")
        : { ok: false as const, status: 400, why: "options, token and signingSecret, or channels" };
      return r.ok ? ok({ ok: true, ...(r.detail ? { detail: r.detail } : {}) }) : fail(r.status, r.why, r.problems ? { problems: r.problems } : {});
    }
    if (body.step === "crm") {
      const r = await saveCrmOptions(c, co.id, body.options);
      return r.ok ? ok({ ok: true }) : fail(r.status, r.why);
    }
    if (body.step === "research") {
      const r = await saveResearchAnswers(c, co.id, body.answers, "dashboard");
      return r.ok ? ok({ ok: true, research: r.research }) : fail(r.status, r.why, r.problems ? { problems: r.problems } : {});
    }
    return fail(400, `no step "${body.step}" yet`);
  });
}
