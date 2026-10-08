/**
 * Operator email for alerts (D33) through Resend's REST API: one call, no SDK. The key comes from the company
 * (`secret.resend_key`) or the server (RESEND_API_KEY); the sender from `alerts.email_from` or ALERT_EMAIL_FROM, and must be
 * on a domain verified in Resend. Nothing here is for contacts: contact email goes through the CRM.
 */
export async function resendSend(apiKey: string, msg: { from: string; to: string[]; subject: string; text: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(msg) });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    return res.ok ? { ok: true, id: data.id } : { ok: false, error: `${res.status} ${data.message ?? data.name ?? ""}`.trim() };
  } catch (e) { return { ok: false, error: String((e as Error).message).slice(0, 160) }; }
}
