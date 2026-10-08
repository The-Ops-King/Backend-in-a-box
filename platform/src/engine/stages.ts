/** Where a workflow sits on the customer's journey (D36). The company page groups by this, in this order; a template carries its stage and a sort within it. */
export const STAGES: { id: string; label: string; about: string }[] = [
  { id: "lead", label: "Lead", about: "a lead arrives" },
  { id: "booking", label: "Booking", about: "a call is booked, moved or cancelled" },
  { id: "pre_call", label: "Pre-call", about: "between the booking and the call" },
  { id: "call", label: "Call", about: "the call itself: recorded, logged" },
  { id: "post_call", label: "Post-call", about: "after the call: follow-up, no-show" },
  { id: "closing", label: "Closing", about: "agreements and the deal" },
  { id: "payments", label: "Payments", about: "money in, money failed" },
  { id: "reactivation", label: "Reactivation", about: "old leads brought back" },
  { id: "team", label: "Team", about: "the team's own reports, on a schedule" },
  { id: "engine", label: "Engine", about: "the engine watching the connections, on a schedule" },
];
export const stageLabel = (id: string | null | undefined) => STAGES.find((s) => s.id === id)?.label ?? "Other";
export const stageIndex = (id: string | null | undefined) => { const i = STAGES.findIndex((s) => s.id === id); return i < 0 ? STAGES.length : i; };
