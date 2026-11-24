/** D344: a calendar copied whole with its own team; the offer's document templates. */
import { describe, it, expect } from "vitest";
import { accountsIn, cloneBody, cloneCalendar, documentTemplates } from "./ghl-calendar-clone";

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
      if (method === "GET" && path.startsWith("/proposals/templates?")) {
        const limit = Number(new URL(`http://x${path}`).searchParams.get("limit")); if (limit > 21) throw new Error('GHL 422: ["limit must not be greater than 21"]');
        return { data: Number(new URL(`http://x${path}`).searchParams.get("skip")) === 0 ? [{ _id: "TPL1", name: "TRC Coaching Agreement" }] : [] };
      }
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

  // D364: the shape TRC's Leap Welcome Calls had: each member's meetings made in their own Zoom connection
  const zoom = (id: string) => ({ isZoomAdded: "true", zoomOauthId: id, locationConfigurations: [{ kind: "zoom_conference", zoomOauthId: id, meetingId: "zoom_conference_0" }] });
  const ZSRC = { ...SRC, teamMembers: [{ userId: "TIFF", priority: 1, isPrimary: true, ...zoom("Z-TIFF") }, { userId: "NICK", priority: 1, ...zoom("Z-NICK") }] };

  it("D364: each person keeps their own Zoom; nobody's calls are made in someone else's account", () => {
    expect(accountsIn(ZSRC.teamMembers[0])).toEqual(["Z-TIFF"]);
    const b = cloneBody(ZSRC, { name: "Nick", userIds: ["NICK"], locationId: "LOC", own: { NICK: ZSRC.teamMembers[1] } });
    expect(JSON.stringify(b.teamMembers)).not.toContain("Z-TIFF");
    expect(b.teamMembers).toEqual([{ ...zoom("Z-NICK"), userId: "NICK", priority: 0.5, isPrimary: true }]);
    // with no connection of their own, the copy is refused rather than borrowing the original's
    expect(() => cloneBody(ZSRC, { name: "Nick", userIds: ["NEW"], locationId: "LOC" })).toThrow(/NEW is on no calendar here with their own meeting connection.*Z-TIFF/);
  });

  it("D364: the copy finds the person's own Zoom on the original, else on another calendar they are on; refused when there is none", async () => {
    const posts: Record<string, unknown>[] = [];
    const http = async (method: string, path: string, o?: { body?: unknown }) => {
      if (method === "GET" && path === "/calendars/CAL1") return { calendar: ZSRC };
      if (method === "GET" && path.startsWith("/calendars/?")) return { calendars: [{ id: "CAL1", name: "Leap Welcome Calls" }, { id: "CAL2", name: "Sales Calls" }] };
      if (method === "GET" && path === "/calendars/CAL2") return { calendar: { id: "CAL2", teamMembers: [{ userId: "JOSE", ...zoom("Z-JOSE") }] } };
      if (method === "POST" && path === "/calendars/") { posts.push(o!.body as Record<string, unknown>); return { calendar: { id: "NEW1" } }; }
      throw new Error(`unexpected ${method} ${path}`);
    };
    await cloneCalendar(http, "LOC", { from: "CAL1", name: "Nick only", userIds: ["NICK"], apply: true });
    await cloneCalendar(http, "LOC", { from: "CAL1", name: "Jose only", userIds: ["JOSE"], apply: true });
    expect(posts.map((p) => (p.teamMembers as { zoomOauthId: string }[])[0].zoomOauthId)).toEqual(["Z-NICK", "Z-JOSE"]);
    await expect(cloneCalendar(http, "LOC", { from: "CAL1", name: "Nobody", userIds: ["NOBODY"], apply: false })).rejects.toThrow(/own meeting connection/);
  });

  it("lists the offer's document templates", async () => {
    expect(await documentTemplates(fakeHttp().http, "LOC")).toEqual([{ id: "TPL1", name: "TRC Coaching Agreement" }]);
  });
});
