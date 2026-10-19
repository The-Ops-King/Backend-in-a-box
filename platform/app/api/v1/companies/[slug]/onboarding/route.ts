import { asOperator } from "@/db/client";
import { companyBySlug } from "@/api/data";
import { fail, ok, readJson } from "@/api/http";
import { onboardingState, saveIntake } from "@/onboarding/store";
import { connect } from "@/onboarding/connections";
import { gather, researchInput, saveResearch, saveResearchAnswers } from "@/onboarding/research";
import { connectSlack, saveChannels, saveSlackOptions } from "@/onboarding/slack";
import { crmInput, runCrm, saveCrm, saveCrmOptions } from "@/onboarding/crm";
import { runInstall } from "@/onboarding/install";
import { approveMessage, editMessage } from "@/onboarding/messages";
import { acceptWorkflow, prepareTests, runScenario } from "@/onboarding/tests";
import { confirmCheck, markWorkflow, readTheirWorkflows, saveList } from "@/onboarding/filters";
import { liveAdapters } from "@/adapters";
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
 * { step: "install" } (D148) → everything the steps learned installed, the playbook's copies on, the company active in ghost.
 * { step: "messages", workflowId, nodeId, approve: true } (D149) → those exact words approved; with field and text instead, the
 * words changed (kept as the company's own). GET …/onboarding/messages lists every client-facing message.
 * { step: "filters", read: true } (D152) → their GHL workflows read live and kept with the marks made; { step: "filters", id, mark,
 * note? } → one marked; { step: "filters", check: true } → read again live and, when nothing is new, unmarked or wrongly on, a check
 * kept for the next move up (every move up needs one). GET …/onboarding/filters says where the list stands.
 * { step: "test", prepare: true, contactId, rung: "ghost" | "test" } (D151) → the test contact chosen, the offer's workflows
 * turned on, the company on that rung; { step: "test", scenario } → that journey run on the test contact (outside any transaction,
 * the company ticked between its steps); { step: "test", accept: workflow, note } → a workflow no scenario reaches, accepted with a
 * note (an empty note takes it back). GET …/onboarding/tests says where the passes stand.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await readJson<{ step?: string; intake?: unknown; playbook?: unknown; id?: unknown; values?: unknown; copyFrom?: unknown; answers?: unknown; options?: unknown; token?: unknown; signingSecret?: unknown; channels?: unknown; run?: unknown; workflowId?: unknown; nodeId?: unknown; approve?: unknown; field?: unknown; text?: unknown; prepare?: unknown; contactId?: unknown; rung?: unknown; scenario?: unknown; accept?: unknown; note?: unknown; read?: unknown; check?: unknown; mark?: unknown }>(req);
  if (!body?.step) return fail(400, "step is required");
  if (body.step === "install") {
    const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
    const r = await runInstall(asOperator, co.id, slug, liveAdapters, "dashboard");
    return r.ok ? ok({ ok: true, installed: r.installed, calendars: r.calendars, playbook: r.playbook }) : fail(r.status, r.why, { ...(r.installed ? { installed: r.installed } : {}), ...(r.playbook ? { playbook: r.playbook } : {}) });
  }
  if (body.step === "filters" && (body.read === true || body.check === true)) {
    const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
    const r = await readTheirWorkflows(asOperator, co.id);
    if (!r.ok) return fail(r.status, r.why);
    if (body.read === true) { await asOperator((c) => saveList(c, co.id, r.list)); return ok({ ok: true, count: r.list.length }); }
    const chk = await asOperator((c) => confirmCheck(c, co.id, r.list, "dashboard"));
    return chk.ok ? ok(chk) : fail(chk.status, chk.why, chk.problems ? { problems: chk.problems } : {});
  }
  if (body.step === "test" && (body.prepare === true || typeof body.scenario === "string")) {
    const co = await asOperator((c) => companyBySlug(c, slug)); if (!co) return fail(404, "no such company");
    if (body.prepare === true) {
      const r = await prepareTests(asOperator, co.id, { contactId: body.contactId, rung: body.rung, by: "dashboard" });
      return r.ok ? ok({ ok: true, on: r.on, left_off: r.left_off }) : fail(r.status, r.why);
    }
    const r = await runScenario(asOperator, liveAdapters, co.id, body.scenario as string, "dashboard");
    return r.ok ? ok({ ok: true, result: r.result }) : fail(r.status, r.why);
  }
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
    if (body.step === "messages") {
      const r = body.approve === true ? await approveMessage(c, co.id, { workflowId: body.workflowId, nodeId: body.nodeId, by: "dashboard" })
        : await editMessage(c, co.id, { workflowId: body.workflowId, nodeId: body.nodeId, field: body.field, text: body.text, by: "dashboard" });
      return r.ok ? ok({ ok: true }) : fail(r.status, r.why);
    }
    if (body.step === "filters") {
      const r = await markWorkflow(c, co.id, { id: body.id, mark: body.mark, note: body.note, by: "dashboard" });
      return r.ok ? ok({ ok: true }) : fail(r.status, r.why);
    }
    if (body.step === "test") {
      const r = await acceptWorkflow(c, co.id, { workflow: body.accept, note: body.note, by: "dashboard" });
      return r.ok ? ok({ ok: true }) : fail(r.status, r.why);
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
