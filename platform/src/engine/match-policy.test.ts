/**
 * D190: how a company finds its people in the CRM. The default (every offer but Dating) is email first and keeps what GHL holds;
 * `contacts.match: phone` (Dating) is phone first and updates the matched contact to the new details.
 */
import { describe, it, expect } from "vitest";
import { findInGhl, matchPolicy, planWrite } from "./typeform";
import type { Adapters, Company, ContactSnapshot } from "@/adapters/types";

const ac = { id: "co", locationId: "L", pit: "p", timezone: "America/Los_Angeles", booking: { source: "ghl" } } as unknown as Company;
const snap = (id: string, over: Partial<ContactSnapshot>): ContactSnapshot => ({ id, tags: [], customFields: {}, dateUpdated: "", dateAdded: "", ...over });
const byEmail = snap("BY-EMAIL", { firstName: "Old", email: "new@x.com", phone: "+15550000001" });
const byPhone = snap("BY-PHONE", { firstName: "Old", lastName: "Name", email: "old@x.com", phone: "+15550000002" });
const adapters = { read: { findDuplicate: async (_c: Company, q: { email?: string; phone?: string }) => (q.email === "new@x.com" ? byEmail : q.phone === "+15550000002" ? byPhone : null) } } as unknown as Adapters;
const parsed = (std: Record<string, string>) => ({ responseId: "", std, fields: [], unbound: [], filled: [] }) as unknown as Parameters<typeof planWrite>[0];

describe("D190: matching a person in the CRM", () => {
  it("the setting: phone is phone first and updates; anything else (or nothing) is the default", () => {
    expect(matchPolicy({ "contacts.match": "phone" })).toEqual({ phoneFirst: true, overwrite: true });
    expect(matchPolicy({ "contacts.match": " Phone " })).toEqual({ phoneFirst: true, overwrite: true });
    expect(matchPolicy({})).toEqual({ phoneFirst: false, overwrite: false });
    expect(matchPolicy({ "contacts.match": "email" })).toEqual({ phoneFirst: false, overwrite: false });
  });

  it("default: an email match wins over a phone match; phone-first: the phone match wins", async () => {
    expect(await findInGhl(ac, adapters, "new@x.com", "+15550000002")).toMatchObject({ snap: { id: "BY-EMAIL" }, by: "email" });
    expect(await findInGhl(ac, adapters, "new@x.com", "+15550000002", matchPolicy({ "contacts.match": "phone" }))).toMatchObject({ snap: { id: "BY-PHONE" }, by: "phone" });
    // no phone given: phone-first still finds them by email
    expect(await findInGhl(ac, adapters, "new@x.com", undefined, matchPolicy({ "contacts.match": "phone" }))).toMatchObject({ snap: { id: "BY-EMAIL" }, by: "email" });
  });

  it("default: a name or email GHL holds is kept (and said); update on match: the new details replace them, blanks are filled either way", () => {
    const p = parsed({ first_name: "Tyler", last_name: "Test", email: "jt+new@x.com", phone: "+15550000002" });
    const kept = planWrite(p, byPhone, []);
    expect(kept.standard).toEqual({});
    expect(kept.kept.sort()).toEqual(["email", "first_name", "last_name"]);
    const updated = planWrite(p, byPhone, [], undefined, true);
    expect(updated.standard).toEqual({ firstName: "Tyler", lastName: "Test", email: "jt+new@x.com" });
    expect(updated.kept).toEqual([]);
    expect(updated.overwrite).toBe(true);
    // the same phone in another format is not a change
    expect(planWrite(parsed({ phone: "(555) 000-0002" }), byPhone, [], undefined, true).standard).toEqual({});
    // a blank in GHL is filled, update or not
    expect(planWrite(parsed({ last_name: "Test" }), byEmail, []).standard).toEqual({ lastName: "Test" });
  });
});
