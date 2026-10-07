import { describe, it, expect } from "vitest";
import { groupOf, mask } from "./settings";
describe("settings screen grouping", () => {
  it("routes every binding key to the section that can pick it from a list", () => {
    expect(groupOf("crm.pipeline_setter")).toBe("pipelines"); expect(groupOf("crm.stage_setter_new_lead")).toBe("stages");
    expect(groupOf("crm.field_contact_hair_loss")).toBe("contact_fields"); expect(groupOf("crm.field_opportunity_setter_owner")).toBe("opportunity_fields");
    expect(groupOf("crm.assoc_payment_contact")).toBe("associations"); expect(groupOf("calendar.closer_call")).toBe("calendars");
    expect(groupOf("slack.channel.bookings")).toBe("slack"); expect(groupOf("prompt.call_notes")).toBe("prompts");
    expect(groupOf("secret.anthropic_key")).toBe("connections"); expect(groupOf("calendly.user")).toBe("booking"); expect(groupOf("booking.setter_rule")).toBe("booking");
    expect(groupOf("crm.location_id")).toBe("other");
  });
  it("secrets are never shown, only that they are set", () => {
    expect(mask("secret", "pit-afe328d9-d7b8-4b33-b937-5fd70c4ae741")).toBe("set · ends with e741");
    expect(mask("id", "abc")).toBe("abc");
  });
});
