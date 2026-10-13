import { describe, it, expect } from "vitest";
import { slackStepsOf } from "./slack-steps";
import { parseDefinition, type Definition } from "@/engine/definition";
import { templates } from "@/templates";

const tpl = (slug: string) => parseDefinition(templates.find((t) => t.slug === slug)!.definition);
const channels = [{ id: "C_REPORTS", name: "hair-reports", is_member: true, is_private: false }, { id: "C_WINS", name: "wins", is_member: false, is_private: false }];
const withChannel = (def: Definition, node: string, channel: string): Definition => ({ ...def, nodes: def.nodes.map((n) => (n.id === node ? { ...n, channel } : n)) as Definition["nodes"] });

describe("where each Slack post goes (D102)", () => {
  it("a wrap-up posts through the company's reports setting, by the channel's name", () => {
    const [s] = slackStepsOf(tpl("daily-wrap-up"), tpl("daily-wrap-up"), { "slack.channel.reports": "C_REPORTS" }, channels);
    expect(s).toMatchObject({ node_id: "n_post", kind: "pick", on_step: false, binding: "slack.channel.reports", default_binding: "slack.channel.reports", posts_to: { id: "C_REPORTS", name: "hair-reports", is_member: true, via: "setting" } });
  });

  it("an empty setting is said, not hidden: the post goes nowhere", () => {
    const [s] = slackStepsOf(tpl("daily-wrap-up"), tpl("daily-wrap-up"), {}, channels);
    expect(s.posts_to).toBeNull();
  });

  it("a channel picked on the step wins, keeps the template's setting to go back to, and flags a channel the bot is not in", () => {
    const def = withChannel(tpl("daily-wrap-up"), "n_post", "C_WINS");
    const [s] = slackStepsOf(def, tpl("daily-wrap-up"), { "slack.channel.reports": "C_REPORTS" }, channels);
    expect(s).toMatchObject({ on_step: true, binding: null, default_binding: "slack.channel.reports", posts_to: { id: "C_WINS", via: "step", is_member: false } });
  });

  it("an empty setting with a fallback says it went to the fallback", () => {
    const def = tpl("payment-unlinked");
    const step = slackStepsOf(def, def, { "slack.channel.bookings": "C_REPORTS" }, channels).find((s) => s.kind === "pick" && s.fallbacks.length);
    expect(step?.posts_to).toMatchObject({ id: "C_REPORTS", via: "fallback", setting: "slack.channel.bookings" });
  });

  it("thread replies and DMs are listed but cannot be picked", () => {
    const kinds = new Set(templates.flatMap((t) => slackStepsOf(parseDefinition(t.definition), null, {}, null).map((s) => s.kind)));
    expect(kinds).toContain("thread");
    for (const t of templates) for (const s of slackStepsOf(parseDefinition(t.definition), null, {}, null)) if (s.kind !== "pick") expect(s.posts_to).toBeNull();
  });
});
