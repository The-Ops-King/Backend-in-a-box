import { describe, it, expect } from "vitest";
import { describeNode, edgeWords, predicateWords, waitWords, templateWords, kindOf } from "./describe";
import { parseDefinition } from "./definition";
import { templates } from "@/templates";

describe("plain-English descriptions", () => {
  it("triggers and checks read like a person wrote them", () => {
    expect(describeNode({ id: "t", type: "trigger", event: "lead.created" }).title).toBe("New lead created");
    expect(describeNode({ id: "t", type: "trigger", event: "appointment.status_changed", match: { eq: ["{{event.status.to}}", "cancelled"] } }).title).toBe("Appointment status changed — new status is “cancelled”");
    expect(describeNode({ id: "c", type: "check", when: { exists: "contact.phone" }, else_exit: "no_phone" })).toEqual({ title: "Check if phone number exists", detail: "If not → stop: no phone number" });
  });
  it("waits speak in clock time and durations", () => {
    expect(waitWords({ anchor: "appointment.starts_at", offset: "day_of@08:00", tz: "contact" })).toBe("Wait until 8:00 AM the day of the call");
    expect(waitWords({ anchor: "appointment.starts_at", offset: "day_before@19:00", tz: "contact" })).toBe("Wait until 7:00 PM the day before the call");
    expect(waitWords({ anchor: "now", offset: "+10m", tz: "contact" })).toBe("Wait 10 minutes");
    expect(waitWords({ anchor: "now", offset: "+2d", tz: "company" })).toBe("Wait 2 days");
    expect(waitWords({ anchor: "now", offset: "day_after@09:00", tz: "contact" })).toBe("Wait until 9:00 AM the next day");
  });
  it("bindings inside message text become names, html is dropped", () => {
    expect(templateWords("<p>Hey {{contact.first_name}},</p><p>grab a time: {{calendar.closer_call.url}}</p>")).toBe("Hey [first name], grab a time: [booking link]");
    expect(describeNode({ id: "n", type: "create_opportunity", pipeline: "{{crm.pipeline_setter}}", stage: "{{crm.stage_setter_new_lead}}", name: "{{contact.name}} -- New", fields: [{ id: "{{crm.field_opportunity_stage_entered}}", value: "{{now | date:yyyy-MM-dd}}" }] }))
      .toEqual({ title: "Create pipeline card “[full name] -- New”", detail: "In the pipeline setter, stage stage setter new lead; set field opportunity stage entered = [today]" });
  });
  it("predicates and edges", () => {
    expect(predicateWords({ eq: ["{{reply.intent}}", "reschedule_request"] })).toBe("the reply is a reschedule request");
    expect(edgeWords({ from: "a", to: "b", else: true })).toBe("otherwise");
    expect(edgeWords({ from: "a", to: "b", label: "timeout" })).toBe("no reply in time");
  });
  it("every shipped node describes without leaking raw paths or ids", () => {
    for (const t of templates) for (const n of parseDefinition(t.definition).nodes) {
      const d = describeNode(n); const all = `${d.title} ${d.detail ?? ""} ${d.quote ?? ""}`;
      expect(all, `${t.slug}/${n.id}`).not.toMatch(/\{\{|\}\}|_at\b|\bn\d\b/);
      expect(kindOf(n)).toBeTruthy();
    }
  });
});
