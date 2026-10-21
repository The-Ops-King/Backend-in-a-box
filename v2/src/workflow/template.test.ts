import { describe, expect, it } from "vitest";
import { FILTERS, type RenderEnv } from "./filters";
import { evaluateExpr, parseTemplate, render, settingsIn, wholeExpr } from "./template";

// Wednesday 2026-10-21, 8:00 AM in Phoenix (UTC-7 all year), 11:00 AM in New York (EDT).
const now = new Date("2026-10-21T15:00:00Z");
const env: RenderEnv = { now, contactZone: "America/Phoenix", offerZone: "America/New_York" };
const at = (hoursFromNow: number) => new Date(now.getTime() + hoursFromNow * 3_600_000).toISOString();
const text = (t: string, ctx: Record<string, unknown> = {}, e: RenderEnv = env) => render(t, ctx, e).text;

describe("parsing a template", () => {
  it("finds every expression with its path, root and filters", () => {
    const p = parseTemplate("Hi {{contact.first_name | default:there}}, see you {{appointment.starts_at | date:time}}.");
    expect(p.errors).toEqual([]);
    expect(p.spans.map((s) => s.expr)).toEqual([
      { path: "contact.first_name", root: "contact", filters: [{ name: "default", arg: "there" }], source: "contact.first_name | default:there" },
      { path: "appointment.starts_at", root: "appointment", filters: [{ name: "date", arg: "time" }], source: "appointment.starts_at | date:time" },
    ]);
  });

  it("reads a quoted argument whole, pipes and colons included", () => {
    const p = parseTemplate('{{contact.setter.name | prefix:"*Setter | lead:*"}}');
    expect(p.errors).toEqual([]);
    expect(p.spans[0]!.expr.filters).toEqual([{ name: "prefix", arg: "*Setter | lead:*" }]);
  });

  it.each([
    ["an unknown filter", "{{contact.name | shout}}", 'unknown filter "shout"'],
    ["an unknown root", "{{company.name}}", '"company" is not a context root'],
    ["a path that is not one", "{{contact..name}}", "is not a path"],
    ["a never-closed {{", "Hi {{contact.name", "never closed"],
    ["a stray }}", "Hi contact.name}}", 'a "}}" with no "{{"'],
    ["an empty {{}}", "Hi {{ }}", "an empty {{}}"],
    ["a filter missing its argument", "{{contact.name | default}}", "default needs an argument"],
    ["an empty default (optional says that)", "{{contact.name | default:}}", "default needs an argument"],
    ["an argument a filter does not take", "{{contact.name | upper:x}}", "upper takes no argument"],
    ["a date format that does not exist", "{{appointment.starts_at | date:ccc LLL d}}", "date format is one of"],
    ["truncate without a number", "{{contact.name | truncate:many}}", "takes a whole number"],
    ["a relative mode that does not exist", "{{appointment.starts_at | relative:days}}", "relative takes auto, minutes or hours"],
    ["fields on now", "{{now.hour}}", "now has no fields"],
    ["setting with no name", "{{setting}}", "setting needs a name"],
    ["an unclosed quoted argument", '{{contact.name | default:"oops}}', "never closed"],
  ])("refuses %s", (_what, t, message) => {
    expect(parseTemplate(t).errors.join(" | ")).toContain(message);
  });

  it("knows when a string is one whole expression, so its value keeps its type", () => {
    expect(wholeExpr("{{event.amount}}")?.path).toBe("event.amount");
    expect(wholeExpr(" {{event.amount}}")).toBeUndefined();
    expect(wholeExpr("{{a.b}}{{c.d}}")).toBeUndefined();
    expect(wholeExpr("$ {{event.amount}}")).toBeUndefined();
  });

  it("lists the settings a template reads", () => {
    expect(settingsIn("{{setting.slack.channel.payments}} and {{setting.calendar.closer_call.url | link:book}} {{contact.name}}"))
      .toEqual(["slack.channel.payments", "calendar.closer_call.url"]);
  });
});

describe("rendering", () => {
  it("fills in values and leaves the words around them alone", () => {
    expect(text("Hi {{contact.first_name}}!", { contact: { first_name: "Ana" } })).toBe("Hi Ana!");
  });

  it("writes numbers, lists and booleans as text", () => {
    expect(text("{{event.n}} {{event.list}} {{event.ok}}", { event: { n: 3, list: ["a", "", "b"], ok: true } })).toBe("3 a, b true");
  });

  it("renders now as the render's own clock", () => {
    expect(text("{{now}}")).toBe("2026-10-21T15:00:00.000Z");
  });

  it("never throws: a template mistake comes back as an error", () => {
    const r = render("{{nope.x}} ok", {}, env);
    expect(r.errors[0]).toContain("not a context root");
    expect(r.text).toBe(" ok");
  });
});

describe("blank detection (the blank-variable hold reads this)", () => {
  it("reports a path the context does not have as missing", () => {
    expect(render("Join: {{appointment.meeting_url}}", { appointment: {} }, env).blanks).toEqual([
      { expr: "appointment.meeting_url", path: "appointment.meeting_url", reason: "missing" },
    ]);
  });

  it("reports a value that is there but empty as empty", () => {
    expect(render("Hi {{contact.first_name}}", { contact: { first_name: "" } }, env).blanks[0]).toMatchObject({ reason: "empty" });
    expect(render("{{event.items}}", { event: { items: [] } }, env).blanks[0]).toMatchObject({ reason: "empty" });
  });

  it("reports a value a filter emptied (a picklist guard that refused it)", () => {
    expect(render("{{event.kind | oneof:deposit,refund}}", { event: { kind: "other" } }, env).blanks).toHaveLength(1);
  });

  it("is quiet when default fills the gap", () => {
    expect(render("Hi {{contact.first_name | default:there}}", {}, env)).toEqual({ text: "Hi there", blanks: [], errors: [] });
  });

  it.each(["optional", "prefix:Setter:", "line", "link"])("is quiet when %s says the value may be absent", (f) => {
    const r = render(`x{{contact.setter.name | ${f}}}`, {}, env);
    expect(r.blanks).toEqual([]);
    expect(r.text).toBe("x");
  });

  it("reports every blank, not just the first", () => {
    expect(render("{{contact.a}} {{contact.b}} {{contact.c | default:ok}}", {}, env).blanks.map((b) => b.path)).toEqual(["contact.a", "contact.b"]);
  });

  it("treats zero and false as values, not blanks", () => {
    expect(render("{{event.n}} {{event.ok}}", { event: { n: 0, ok: false } }, env).blanks).toEqual([]);
  });
});

describe("filters", () => {
  it("has the fixed set and no more", () => {
    expect(Object.keys(FILTERS).sort()).toEqual([
      "abs", "date", "default", "first_name", "hour", "hours_until", "join", "line", "link", "lower", "minus", "money",
      "offer_date", "oneof", "optional", "plus", "prefix", "relative", "truncate", "upper",
    ]);
  });

  it("plus and minus move a date-time by a duration, for time arithmetic", () => {
    const ctx = { appointment: { starts_at: "2026-10-22T21:00:00Z", booked_at: "2026-10-20T09:00:00.000Z" } };
    expect(text("{{appointment.starts_at | minus:30m}}", ctx)).toBe("2026-10-22T20:30:00.000Z");
    expect(text("{{appointment.booked_at | plus:1d}}", ctx)).toBe("2026-10-21T09:00:00.000Z");
    expect(text("{{appointment.starts_at | minus:2h | date:time}}", ctx)).toBe("12:00 PM");
    expect(parseTemplate("{{appointment.starts_at | minus:30 minutes}}").errors[0]).toContain("duration");
    expect(parseTemplate("{{appointment.starts_at | plus}}").errors[0]).toContain("needs an argument");
    const r = render("{{appointment.ends_at | minus:30m}}", ctx, env);
    expect(r.blanks.map((b) => b.path)).toEqual(["appointment.ends_at"]);
    expect(render("{{appointment.call_type | minus:30m}}", { appointment: { call_type: "closing" } }, env).errors[0]).toContain("not a date");
  });

  it("lower, upper, first_name, truncate", () => {
    const ctx = { contact: { name: "Ana Maria Lopez" } };
    expect(text("{{contact.name | lower}}|{{contact.name | upper}}|{{contact.name | first_name}}|{{contact.name | truncate:5}}", ctx))
      .toBe("ana maria lopez|ANA MARIA LOPEZ|Ana|Ana …");
    expect(text("{{contact.name | truncate:50}}", ctx)).toBe("Ana Maria Lopez");
  });

  it("money writes thousands and cents, money:N rounds", () => {
    const ctx = (amount: unknown) => ({ event: { amount } });
    expect(text("{{event.amount | money}}", ctx(2999))).toBe("2,999");
    expect(text("{{event.amount | money}}", ctx(2999.5))).toBe("2,999.50");
    expect(text("{{event.amount | money}}", ctx("1500"))).toBe("1,500");
    expect(text("{{event.amount | money:0}}", ctx(2999.5))).toBe("3,000");
    expect(text("{{event.amount | money:2}}", ctx(10))).toBe("10.00");
    expect(render("{{event.amount | money}}", ctx("n/a"), env).blanks).toHaveLength(1);
  });

  it("abs drops the sign of a refund", () => {
    expect(text("−${{event.amount | abs | money}}", { event: { amount: -500 } })).toBe("−$500");
  });

  it("join puts a list on one line", () => {
    const ctx = { contact: { tags: ["a", "b", "c"] } };
    expect(text("{{contact.tags | join}}", ctx)).toBe("a, b, c");
    expect(text('{{contact.tags | join:" / "}}', ctx)).toBe("a / b / c");
  });

  it("prefix, line and link write a labelled value only when there is one", () => {
    const ctx = { contact: { setter: { name: "Luis" } }, recording: { url: "https://x.test/r" } };
    expect(text('{{contact.setter.name | prefix:"*Setter:*"}}', ctx)).toBe("*Setter:* Luis");
    expect(text('Closer{{contact.setter.name | line:"*Setter:*"}}', ctx)).toBe("Closer\n*Setter:* Luis");
    expect(text("{{recording.url | link:Recording}}", ctx)).toBe("<https://x.test/r|Recording>");
    expect(text("{{recording.url | link}}", ctx)).toBe("<https://x.test/r|https://x.test/r>");
  });

  it("oneof keeps only a listed option", () => {
    expect(text("{{event.kind | oneof:deposit,refund}}", { event: { kind: "refund" } })).toBe("refund");
  });

  describe("dates", () => {
    const ctx = { appointment: { starts_at: "2026-10-22T21:00:00Z" } }; // Thu 2:00 PM Phoenix, 5:00 PM New York
    it.each([
      ["long", "Thursday, October 22 at 2:00 PM"],
      ["medium", "Thu, Oct 22 at 2:00 PM"],
      ["day", "Thursday, October 22"],
      ["short_day", "Thu, Oct 22"],
      ["time", "2:00 PM"],
      ["time_zone", "2:00 PM MST"],
      ["weekday", "Thursday"],
      ["iso_date", "2026-10-22"],
    ])("date:%s in the contact's zone", (format, expected) => {
      expect(text(`{{appointment.starts_at | date:${format}}}`, ctx)).toBe(expected);
    });

    it("offer_date writes the offer's zone, for what the team reads", () => {
      expect(text("{{appointment.starts_at | offer_date:time_zone}}", ctx)).toBe("5:00 PM EDT");
    });

    it("date falls back to the offer's zone when the contact has none", () => {
      expect(text("{{appointment.starts_at | date:time}}", ctx, { now, offerZone: "America/New_York" })).toBe("5:00 PM");
    });

    it("a bare calendar day stays that day in any zone", () => {
      expect(text("{{event.day | date:iso_date}}", { event: { day: "2026-10-29" } })).toBe("2026-10-29");
      expect(text("{{event.day | date:iso_date}}", { event: { day: "2026-10-29" } }, { now, offerZone: "Asia/Tokyo" })).toBe("2026-10-29");
    });

    it("an absent date passes through to default", () => {
      expect(text("{{contact.first_booked_at | date:medium | default:—}}", {})).toBe("—");
    });

    it("a value that is not a date is an error, and the text is held", () => {
      const r = render("{{event.when | date:time}}", { event: { when: "soon" } }, env);
      expect(r.errors[0]).toContain("not a date");
    });

    it("hours_until and hour are numbers, for conditions", () => {
      const r = evaluateExpr(parseTemplate("{{appointment.starts_at | hours_until}}").spans[0]!.expr, { appointment: { starts_at: at(1.5) } }, env);
      expect(r.value).toBe(1.5);
      expect(evaluateExpr(parseTemplate("{{appointment.starts_at | hours_until}}").spans[0]!.expr, { appointment: { starts_at: at(-2) } }, env).value).toBe(-2);
      expect(evaluateExpr(parseTemplate("{{appointment.starts_at | hour}}").spans[0]!.expr, ctx, env).value).toBe(14);
    });
  });

  describe("relative", () => {
    const rel = (hours: number, mode = "") => text(`{{appointment.starts_at | relative${mode}}}`, { appointment: { starts_at: at(hours) } });
    it("says minutes under an hour, hours under four", () => {
      expect(rel(0.5)).toBe("in about 30 minutes");
      expect(rel(1)).toBe("in about an hour");
      expect(rel(2)).toBe("in about 2 hours");
      expect(rel(2.5)).toBe("in about 2.5 hours");
    });
    it("says today, tomorrow, the weekday, then the date", () => {
      expect(rel(10)).toBe("today at 6pm");
      expect(rel(25.5)).toBe("tomorrow at 9:30am");
      expect(rel(3 * 24 + 6)).toBe("Saturday at 2pm");
      expect(rel(10 * 24 + 6)).toBe("Sat, Oct 31 at 2pm");
    });
    it("takes minutes or hours as a mode", () => {
      expect(rel(2, ":minutes")).toBe("in about 120 minutes");
      expect(rel(0.4, ":hours")).toBe("in about an hour");
    });
    it("refuses a time that has passed, so a stale message never goes out", () => {
      const r = render("{{appointment.starts_at | relative}}", { appointment: { starts_at: at(-0.5) } }, env);
      expect(r.errors[0]).toContain("is not in the future");
    });
  });
});
