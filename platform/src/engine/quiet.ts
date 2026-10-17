/**
 * D124: "for this client I want nothing to post if nothing happened." A company setting (install `quietWhenEmpty`, bound as
 * `reports.quiet_when_empty`); a scheduled Slack post that opts in with `quiet_when_empty: "vars.<step>.nothing"` is not
 * posted when the step before it found nothing. "Nothing" is that step's own fact, from the data (reports.ts, leaderboard.ts),
 * never read off the words. Unset, nothing changes.
 */
export const QUIET_KEY = "reports.quiet_when_empty";
export const quietWhenEmpty = (bindings: Record<string, string>) => /^(true|yes|on|1)$/i.test((bindings[QUIET_KEY] ?? "").trim());

/** The run log's reason, the send's suppressed reason, and the chart's words for a post that opts in while the setting is on. */
export const QUIET_WHY = "nothing happened, so nothing was posted (quiet when empty)";
export const QUIET_SUPPRESSED = "quiet when empty: nothing happened";
export const QUIET_ONLY_IF = "something happened";
export const QUIET_COND = "Only if something happened: this company posts nothing when nothing happened (quiet when empty); a run started by hand posts anyway";
