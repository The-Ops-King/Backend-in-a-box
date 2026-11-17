/** D344: a calendar copied whole with its own team; the offer's document templates. */
import { describe, it, expect } from "vitest";
import { cloneBody, cloneCalendar, documentTemplates } from "./ghl-calendar-clone";

const SRC = { id: "CAL1", locationId: "LOC", name: "Leap Welcome Calls", slug: "leap-welcome", widgetSlug: "leap-welcome", dateAdded: "x", calendarType: "round_robin", slotDuration: 30, slotDurationUnit: "mins",
  openHours: [{ daysOfTheWeek: [1], hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }] }], formId: "FORM1", notifications: [{ type: "email" }], locationConfigurations: [{ kind: "zoom_conference" }],
  teamMembers: [{ userId: "TIFF", priority: 1, isPrimary: true, meetingLocationType: "zoom", meetingLocation: "zoom" }, { userId: "NICK", priority: 0.5, isPrimary: false, meetingLocationType: "zoom" }] };

describe("D344: clone a GHL calendar", () => {
  it("copies what it was set up with, drops what GHL owns, and puts only the named team on it with the original's meeting settings", () => {
    const b = cloneBody(SRC, { name: "Leap Welcome Call - Nick", userIds: ["NICK"], locationId: "LOC" });
    expect(b).toMatchObject({ name: "Leap Welcome Call - Nick", slug: "leap-welcome-call-nick", widgetSlug: "leap-welcome-call-nick", locationId: "LOC", calendarType: "round_robin", slotDuration: 30, formId: "FORM1", openHours: SRC.openHours, notifications: SRC.notifications, locationConfigurations: SRC.locationConfigurations });
    expect(b.teamMembers).toEqual([{ userId: "NICK", priority: 0.5, isPrimary: true, meetingLocationType: "zoom", meetingLocation: "zoom" }]);
    for (const k of ["id", "dateAdded"]) expect(b).not.toHaveProperty(k);
  });

  const fakeHttp = (opts: { existing?: string[]; refuse?: string[] } = {}) => {
    const posts: Record<string, unknown>[] = []; let refuse = [...(opts.refuse ?? [])];
    const http = async (method: string, path: string, o?: { body?: unknown }) => {
      if (method === "GET" && path === "/calendars/CAL1") return { calendar: SRC };
      if (method === "GET" && path.startsWith("/calendars/?")) return { calendars: [{ id: "CAL1", name: "Leap Welcome Calls" }, ...(opts.existing ?? []).map((n, i) => ({ id: `E${i}`, name: n }))] };
      if (method === "POST" && path === "/calendars/") {
        const body = o!.body as Record<string, unknown>; const bad = refuse.filter((k) => k in body);
        if (bad.length) { refuse = []; throw new Error(`GHL 422 on /calendars/: {"message":[${bad.map((k) => `"property ${k} should not exist"`).join(",")}]}`); }
        posts.push(body); return { calendar: { id: "NEW1" } };
      }
      if (method === "GET" && path.startsWith("/proposals/templates?")) return { data: [{ _id: "TPL1", name: "TRC Coaching Agreement" }] };
      throw new Error(`unexpected ${method} ${path}`);
    };
    return { http, posts };
  };

  it("a dry run makes nothing; applied it makes one; a field GHL refuses is left out and said; one with that name already is never made twice", async () => {
    const f = fakeHttp({ refuse: ["notifications"] });
    expect(await cloneCalendar(f.http, "LOC", { from: "CAL1", name: "Leap Welcome Call - Nick", userIds: ["NICK"], apply: false })).toMatchObject({ would: "create" });
    expect(f.posts).toHaveLength(0);
    const made = await cloneCalendar(f.http, "LOC", { from: "CAL1", name: "Leap Welcome Call - Nick", userIds: ["NICK"], apply: true });
    expect(made).toMatchObject({ would: "create", created: { id: "NEW1" }, left_out: ["notifications"] });
    expect(f.posts).toHaveLength(1); expect(f.posts[0]).not.toHaveProperty("notifications"); expect(f.posts[0]).toHaveProperty("formId", "FORM1");
    const again = fakeHttp({ existing: ["leap welcome call - nick"] });
    expect(await cloneCalendar(again.http, "LOC", { from: "CAL1", name: "Leap Welcome Call - Nick", userIds: ["NICK"], apply: true })).toMatchObject({ would: "exists", created: { id: "E0" } });
    expect(again.posts).toHaveLength(0);
  });

  it("lists the offer's document templates", async () => {
    expect(await documentTemplates(fakeHttp().http, "LOC")).toEqual([{ id: "TPL1", name: "TRC Coaching Agreement" }]);
  });
});
