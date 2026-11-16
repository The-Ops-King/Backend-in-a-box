import type { PoolClient } from "pg";
import { many } from "@/db/client";
import type { Adapters } from "@/adapters/types";
import type { Issue } from "./readiness";
import type { Mode } from "./mode";
import { loadCompany } from "./context";
import { parseDefinition } from "./definition";
import { render } from "./template";
import { closerOptions, objectKey } from "./sales-call";
import { offOptions } from "./executor";

/**
 * D339 (TRC, 2026-11-16): TRC's Sales Call Closer field is a dropdown (option keys `nick`, `tiffany`) and `sales_call.closer_options`
 * was `{}`, so the engine wrote the closer's name ("Nick Rowe") and GHL refused every Sales Call write ("isn't an allowed option for
 * Closer"). Only the health sweep's ledger drift saw it. A workflow that writes the Sales Call's closer cannot go up into quiet or live
 * while the value the engine would write for a closer on the roster is not one of the field's options (its key or label, any case, as
 * D302's executor check takes them). A closer the declared map leaves out is written blank: said, not blocking.
 *
 * The field's options are only in GHL, so they are read live, once, and only when a workflow moving up writes the closer; a read that
 * fails is a blocker (the check never quietly drops out).
 */
const WRITES: Mode[] = ["quiet", "live"];
const OPTION = /\|\s*option:\s*sales_call_closer\b/;

export async function closerFieldBlockers(c: PoolClient, companyId: string, moving: string[], after: (w: { id: string; own: Mode | null }) => Mode, slugPrefix: string, adapters: Adapters): Promise<Issue[]> {
  if (!moving.length) return [];
  const rows = await many<{ id: string; name: string; own: Mode | null; definition: unknown }>(c, `select w.id, w.name, w.mode as own, v.definition from workflows w
    join workflow_versions v on v.workflow_id=w.id and v.version=w.current_version where w.company_id=$1 and w.id = any($2::uuid[]) order by w.name`, [companyId, moving]);
  const { adapterCompany, bindings } = await loadCompany(c, companyId);
  const salesCall = objectKey(bindings, "sales_call");
  const crm = Object.fromEntries(Object.entries(bindings).filter(([k]) => k.startsWith("crm.")).map(([k, v]) => [k.slice(4), v]));
  // each moving workflow's Sales Call closer writes: whether the value goes through the company's option keys
  const writers: { id: string; name: string; viaOption: boolean }[] = [];
  for (const w of rows) {
    if (!WRITES.includes(after(w))) continue;
    let nodes; try { nodes = parseDefinition(w.definition).nodes; } catch { continue; }   // an unparseable one is readiness's blocker already
    for (const n of nodes) {
      if (n.type !== "crm_record" || !n.properties.closer?.trim()) continue;
      let object: string; try { object = render(n.object, { crm }, { tz: "UTC" } as never).trim(); } catch { continue; }
      if (object === salesCall) writers.push({ id: w.id, name: w.name, viaOption: OPTION.test(n.properties.closer) });
    }
  }
  if (!writers.length) return [];
  const roster = await many<{ name: string; email: string | null; ghl_user_id: string | null }>(c, "select name, email, ghl_user_id from users where company_id=$1 and role='closer' and active order by name", [companyId]);
  if (!roster.length) return [];
  const names = [...new Set(writers.map((x) => x.name))].join(", "), href = `${slugPrefix}/w/${writers[0].id}`;
  if (!adapters.read.objectFields) return [{ level: "blocker", href, text: `${names} write the Sales Call's Closer, and this engine cannot read the field's options to check each closer is one of them.` }];
  let options: { key: string; label?: string }[] | undefined;
  try { options = (await adapters.read.objectFields(adapterCompany, salesCall)).find((f) => f.key === "closer")?.options; }
  catch (e) { return [{ level: "blocker", href, text: `${names} write the Sales Call's Closer, and its options could not be read from GHL to check them (${String((e as Error).message).slice(0, 140)}). Try again.` }]; }
  if (!options?.length) return [];   // not a choice field (or none on the object): any text is taken
  const declared = closerOptions(bindings, roster);
  const allowed = options.map((o) => o.key).join(", ");
  const out: Issue[] = [];
  for (const u of roster) {
    const name = u.name.trim(), mapped = declared?.[name.toLowerCase()];
    for (const viaOption of [...new Set(writers.map((x) => x.viaOption))]) {
      const value = viaOption && declared ? mapped ?? "" : name;
      const who = writers.filter((x) => x.viaOption === viaOption).map((x) => x.name).join(", ");
      if (!value) { out.push({ level: "warning", href, text: `${who}: ${name} has no entry in sales_call.closer_options, so their Sales Calls are written with no Closer. Add theirs ({"${u.email ?? name}": "<one of ${allowed}>"}).` }); continue; }
      if (!offOptions({ closer: value }, new Map([["closer", options]])).length) continue;
      out.push({ level: "blocker", href, text: mapped && viaOption
        ? `${who} would write ${name}'s Sales Calls with Closer "${value}" (their sales_call.closer_options entry), which the Closer field does not offer (${allowed}): GHL refuses the write. Fix their entry, or add the option in GHL.`
        : `${who} would write ${name}'s Sales Calls with Closer "${value}", which the Closer field (a dropdown: ${allowed}) does not offer: GHL refuses the write. Map them in sales_call.closer_options ({"${u.email ?? name}": "<option key>"}), or add the option in GHL.` });
    }
  }
  return out;
}
