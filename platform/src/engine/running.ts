/**
 * Which companies the engine runs (polls, ticks, schedules, alerts): active and hosted ones, and (D182) the one template business
 * checked out to the sandbox. A template business is otherwise inert (D178); its playbook's businesses share one sandbox GHL
 * location, so only one runs there at a time: two would see each other's test contacts and fire on each other's writes.
 */
export const SANDBOX_KEY = "sandbox.running";
/** The rule in SQL over a companies row aliased `co`. */
export const runningSql = (co = "co") =>
  `(${co}.status in ('active','hosted') or (${co}.status='template' and exists (select 1 from bindings sb where sb.company_id=${co}.id and sb.key='${SANDBOX_KEY}')))`;
