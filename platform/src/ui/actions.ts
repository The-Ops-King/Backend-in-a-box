"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { asOperator, one } from "@/db/client";
import { recordDisposition } from "@/engine/disposition";

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
