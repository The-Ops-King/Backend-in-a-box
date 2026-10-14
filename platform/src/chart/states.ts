/** What each step state means, in the words the legend and the tooltips use; one colour each, the same on the bars and the chart. */
export const STATE_WORDS: Record<string, string> = { ok: "ran", ghost: "ran in shadow", skip: "skipped: condition not met", blocked: "blocked: did not go out", here: "waiting here", warn: "failed or needs a hand", stop: "stopped", next: "not reached yet" };
export const STATE_ORDER = ["ok", "ghost", "skip", "blocked", "here", "warn", "stop", "next"];
