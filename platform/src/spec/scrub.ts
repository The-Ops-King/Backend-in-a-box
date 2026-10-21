/**
 * Deterministic pseudonyms for a trace export: the same real value always becomes the same token within one export
 * ("contact-3", "email-2"), so a trace still shows that two steps were about the same person without saying who.
 * Emails, phones (by their digits) and URLs carrying a token are found by their shape; known values (a contact's names and
 * CRM id, staff names, Slack ids) are replaced wherever they appear; then anything still shaped like a UUID, a Slack user id
 * or a CRM id.
 */
export type Kind = "contact" | "staff" | "email" | "phone" | "crm-id" | "slack-user" | "id" | "url";

const NAME_KEYS = /^(first_name|last_name|full_name|name|contact_name|user_name|customer_name|closer_name|setter_name|invitee_name|recorded_by_name)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w-])\+?\(?\d[\d\s().-]{8,}\d(?![\w-])/g;
const SLACK_RE = /\b[UW][A-Z0-9]{8,11}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const CRM_ID_RE = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20,24}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

export class Scrubber {
  private map = new Map<string, string>();
  private counts = new Map<Kind, number>();
  private known: { value: string; kind: Kind }[] = [];

  token(kind: Kind, value: string): string {
    const k = `${kind}:${value.toLowerCase()}`;
    let t = this.map.get(k);
    if (!t) { const n = (this.counts.get(kind) ?? 0) + 1; this.counts.set(kind, n); t = `<${kind}-${n}>`; this.map.set(k, t); }
    return t;
  }

  /** A value to replace wherever it appears, under a token of its kind. Short values (initials, "Jo") are skipped as too likely to hit ordinary words. */
  learn(kind: Kind, value: string | null | undefined): void {
    const v = value?.trim();
    if (!v || v.length < 3 || kind === "email" || kind === "phone") return;   // found by their shape, normalised, so one person is one token
    if (!this.known.some((x) => x.value.toLowerCase() === v.toLowerCase())) this.known.push({ value: v, kind });
    this.known.sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value));
  }

  text(s: string): string {
    let out = s;
    // shapes first, so an email or a phone becomes one token rather than a name inside it
    out = out.replace(URL_RE, (u) => /[?&][^=]*(token|key|sig|secret|auth|code)[^=]*=|\/[A-Za-z0-9_-]{24,}/i.test(u) ? this.token("url", u) : u);
    out = out.replace(EMAIL_RE, (m) => this.token("email", m));
    out = out.replace(PHONE_RE, (m) => { const d = m.replace(/\D/g, ""); return d.length >= 10 ? this.token("phone", d.length === 11 && d.startsWith("1") ? d.slice(1) : d) : m; });
    for (const { value, kind } of this.known) out = out.replace(new RegExp(`(?<![A-Za-z0-9<-])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9>])`, "gi"), () => this.token(kind, value));
    out = out.replace(UUID_RE, (m) => this.token("id", m));
    out = out.replace(SLACK_RE, (m) => this.token("slack-user", m));
    out = out.replace(CRM_ID_RE, (m) => this.token("crm-id", m));
    return out;
  }

  /** A JSON value with every string scrubbed; a field that holds a person's name becomes a token whatever it says. */
  value(v: unknown, key?: string): unknown {
    if (typeof v === "string") return key && NAME_KEYS.test(key) && v.trim() ? this.token("contact", v.trim()) : this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.value(x, k)]));
    return v;
  }
}
