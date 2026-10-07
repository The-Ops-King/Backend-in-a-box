import { describe, it, expect } from "vitest";
import { validateCopy } from "./copy";
describe("copy edits are checked before they are saved", () => {
  it("accepts known placeholders, rejects unknown roots, unclosed braces and empty text", () => {
    expect(validateCopy("Hey {{contact.first_name}}, see you {{appointment.starts_at | relative}}")).toEqual({ ok: true });
    expect(validateCopy("Hi {{customer.name}}")).toMatchObject({ ok: false, why: /unknown placeholder.*customer\.name/ });
    expect(validateCopy("Hi {{contact.first_name")).toMatchObject({ ok: false, why: /not closed/ });
    expect(validateCopy("   ")).toMatchObject({ ok: false, why: /empty/ });
  });
});
