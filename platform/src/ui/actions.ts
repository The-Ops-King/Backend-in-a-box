"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asOperator, one } from "@/db/client";
import { recordDisposition } from "@/engine/disposition";
import { linkPayment } from "@/engine/payments";
import { linkRecording } from "@/engine/recordings";
import { loadCompany } from "@/engine/context";
import { simulate, SIM_ACTIONS, type SimAction } from "@/engine/simulate";
import { saveCopy, type CopyField } from "@/engine/copy";
import { saveStepEdit, type StepEdit } from "@/engine/edits";
import { dispatchEvent } from "@/engine/dispatch";

export async function toggleWorkflow(formData: FormData) {
  const id = String(formData.get("id")), slug = String(formData.get("slug"));
  await asOperator(async (c) => {
    const w = await one<{ enabled: boolean; company_id: string; name: string }>(c, "select enabled, company_id, name from workflows where id=$1", [id]);
    if (!w) return;
    await c.query("update workflows set enabled=not enabled where id=$1", [id]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,$2,'workflow',$3,$4,$5)", [w.company_id, w.enabled ? "workflow.disabled" : "workflow.enabled", id, { enabled: w.enabled }, { enabled: !w.enabled }]);
  });
  revalidatePath(`/c/${slug}/w/${id}`); revalidatePath(`/c/${slug}`);
}

export async function submitDisposition(formData: FormData) {
  const slug = String(formData.get("slug")), companyId = String(formData.get("companyId")), appointmentId = String(formData.get("appointmentId"));
  const outcomeTermId = String(formData.get("outcome") ?? ""); const callOutcomeTermId = String(formData.get("call_outcome") ?? "") || null;
  const notes = String(formData.get("notes") ?? "").trim();
  if (!outcomeTermId) return;
  await asOperator((c) => recordDisposition(c, { companyId, appointmentId, outcomeTermId, callOutcomeTermId, notes }));
  revalidatePath(`/c/${slug}/appointments`); revalidatePath(`/c/${slug}`);
  redirect(`/c/${slug}/appointments/${appointmentId}`);
}

export async function toggleMode(formData: FormData) {
  const slug = String(formData.get("slug"));
  await asOperator(async (c) => {
    const co = await one<{ id: string; mode: string }>(c, "select id, mode from companies where slug=$1", [slug]);
    if (!co) return;
    const next = co.mode === "live" ? "shadow" : "live";
    await c.query("update companies set mode=$2 where id=$1", [co.id, next]);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, before, after) values ($1,'company.mode','company',$1,$2,$3)", [co.id, { mode: co.mode }, { mode: next }]);
  });
  revalidatePath(`/c/${slug}`); revalidatePath("/");
}

/** Operator links an unlinked payment to a contact. The payment settles and its workflows start, exactly as if it had matched on arrival. */
export async function linkPaymentAction(formData: FormData) {
  const slug = String(formData.get("slug")), companyId = String(formData.get("companyId")), paymentId = String(formData.get("paymentId")), contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return;
  await asOperator(async (c) => {
    const { event } = await linkPayment(c, companyId, paymentId, contactId);
    await dispatchEvent(c, event, { contact: { id: contactId } });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'payment.linked','payment',$2,$3)", [companyId, paymentId, { contact_id: contactId }]);
  });
  revalidatePath(`/c/${slug}/payments`); revalidatePath(`/c/${slug}`);
}

/** Operator links an unmatched recording to a contact. The recording settles and call-recorded starts, exactly as if it had matched on arrival. */
export async function linkRecordingAction(formData: FormData) {
  const slug = String(formData.get("slug")), companyId = String(formData.get("companyId")), recordingId = String(formData.get("recordingId")), contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return;
  await asOperator(async (c) => {
    const { event, appointmentId } = await linkRecording(c, companyId, recordingId, contactId);
    const appt = appointmentId ? await one<Record<string, unknown>>(c, "select a.id, a.starts_at, a.status, json_build_object('category', t.category) as term from appointments a join company_terms t on t.id=a.appointment_term where a.id=$1", [appointmentId]) : null;
    await dispatchEvent(c, event, { contact: { id: contactId }, appointment: appt ?? undefined });
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,'recording.linked','recording',$2,$3)", [companyId, recordingId, { contact_id: contactId }]);
  });
  revalidatePath(`/c/${slug}/recordings`); revalidatePath(`/c/${slug}`);
}

/** Stage a synthetic step for this contact from the dashboard (D23): nothing reaches the CRM, Calendly or a Zap. */
export async function simulateAction(formData: FormData) {
  const slug = String(formData.get("slug")), companyId = String(formData.get("companyId")), contactId = String(formData.get("contactId")), action = String(formData.get("action"));
  if (!(SIM_ACTIONS as readonly string[]).includes(action)) return;
  await asOperator(async (c) => {
    const { row } = await loadCompany(c, companyId);
    const r = await simulate({ c, company: row, contactId }, action as SimAction);
    await c.query("insert into audit_log (company_id, action, target_type, target_id, after) values ($1,$2,'contact',$3,$4)", [companyId, `simulate.${action}`, contactId, r.ok ? { ...r.detail, runs_started: r.runsStarted, via: "dashboard" } : { refused: r.why }]);
  });
  revalidatePath(`/c/${slug}/contacts/${contactId}`); revalidatePath(`/c/${slug}`);
}

/** Edit the words of one message in this company's copy of a workflow: a new version, validated, marked as edited. */
export async function saveCopyAction(formData: FormData) {
  const slug = String(formData.get("slug")), workflowId = String(formData.get("workflowId")), nodeId = String(formData.get("nodeId")), field = String(formData.get("field")) as CopyField, text = String(formData.get("text") ?? "");
  const r = await asOperator((c) => saveCopy(c, { workflowId, nodeId, field, text }));
  revalidatePath(`/c/${slug}/w/${workflowId}`);
  redirect(`/c/${slug}/w/${workflowId}?${r.ok ? `saved=${nodeId}` : `error=${encodeURIComponent(r.why)}`}#copy-${nodeId}`);
}

/** GHL-style: set the pipeline, stage, owner, channel or tags on the step itself, in this company's copy. */
export async function saveStepAction(formData: FormData) {
  const slug = String(formData.get("slug")), workflowId = String(formData.get("workflowId")), nodeId = String(formData.get("nodeId")), type = String(formData.get("type"));
  const g = (k: string) => { const v = formData.get(k); return v === null ? undefined : String(v).trim(); };
  let edit: StepEdit;
  if (type === "pipeline_card") {
    // one picker carries "pipelineId|stageId" so the stage always matches its pipeline
    const combo = g("pipeline_stage"); const [pipeline, stage] = combo ? combo.split("|") : [undefined, undefined];
    edit = { type, pipeline, stage, name: g("name"), assign_to: g("assign_to"), status: g("status") as StepEdit extends { status?: infer S } ? S : never, if_missing: (g("if_missing") || undefined) as "create" | "skip" | undefined };
  } else if (type === "slack_post") edit = { type, channel: g("channel") };
  else if (type === "set_tag" || type === "remove_tag") edit = { type, tags: (g("tags") ?? "").split(/[\n,]/) };
  else if (type === "update_contact") edit = { type, assign_to: g("assign_to") };
  else if (type === "create_task") edit = { type, assign_to: g("assign_to"), due: g("due") };
  else if (type === "set_var") edit = { type, value: g("value") };
  else if (type === "wait") edit = { type, offset: g("offset") };
  else if (type === "send_sms" || type === "send_email") edit = { type, ghl_template: g("ghl_template") };
  else return;
  const r = await asOperator((c) => saveStepEdit(c, { workflowId, nodeId, edit }));
  revalidatePath(`/c/${slug}/w/${workflowId}`);
  redirect(`/c/${slug}/w/${workflowId}?${r.ok ? `saved=${nodeId}` : `error=${encodeURIComponent(r.why)}`}#step-${nodeId}`);
}
