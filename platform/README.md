# platform/ — the engine

Next.js 15 (API routes only, no dashboard yet), Postgres 16, deployed on Vercel with a one-minute
cron. Design is in `../engine/`; this is what runs.

## What works today (verified live against GHL location RHOfV4fFknN54YQobyWp, 2026-10-06)

- **Install** a company from the CLI: terms from the core vocabulary, encrypted bindings, closers
  from the GHL roster, calendars mapped to appointment types, templates copied and enabled only
  when every required binding exists.
- **Poll** GHL every tick: contacts by `dateUpdated`, appointments per calendar, inbound
  conversations. First poll is a silent baseline; only deltas become events.
- **Dispatch** events to workflow triggers with reentry policies (no double runs).
- **Execute** runs: wait rules (morning-of, evening-before fallback, in the contact's timezone),
  send window (defer forward, never at 2am), live premise check (a cancelled appointment exits
  the run instead of sending), send-time rendering, idempotent sends ledger, Jev classify →
  branch, tags, notes, read-then-write appointment updates, pause on human takeover.
- **Recovery mode** after a scheduler gap: dead runs exit first, sends drip instead of burst.
- **Lifecycle**: first booking opens an opportunity; payment (Whop webhook) wins it; paid-in-full
  is detected from the payments sum.

Live proof: a real appointment booked in GHL was detected, both workflows started, the
confirmation email went out through GHL into the contact's thread, the reminder is waiting for
8am the morning of. 25 tests pass (`pnpm test`), including the end-to-end suite against Postgres.

## Run it locally

```bash
cd platform && pnpm install
cp .env.example .env            # fill DATABASE_URL, BINDINGS_KEY (openssl rand -base64 32)
pnpm db:migrate                 # applies ../engine/schema.sql + forces RLS on every tenant table
pnpm install:company --name "Save Your Hair" --slug syh --tz America/Phoenix \
  --location <ghl_location_id> --pit <private_integration_token> \
  --calendar <ghl_calendar_id>=closing --calendar <ghl_calendar_id>=first_call
pnpm tick                       # one poll + one scheduler pass; this is what the cron does
# Workflows install OFF. Add --enable to the install command (or flip `workflows.enabled`) when you mean it.
pnpm test
```

## Deploy (Vercel)

Project `backend-in-a-box` exists in team `jtylerray` (root directory `platform`). The route
`/api/tick` checks `Authorization: Bearer $CRON_SECRET`.

**Scheduling depends on the Vercel plan.** The team is on Hobby today, which allows daily crons only
— a deploy with `* * * * *` is rejected outright (`cron_jobs_limits_reached`). So:

| Plan | Minute scheduler | `vercel.json` cron |
|---|---|---|
| Hobby (now) | `.github/workflows/tick.yml` every 5 min (needs repo secrets `TICK_URL`, `CRON_SECRET`) | daily `0 9 * * *` = the reconciliation sweep |
| Pro | `vercel.json` set to `* * * * *` | the Actions workflow stays on as the backup scheduler |

Five-minute latency is fine for testing and wrong for production reminders; Pro is the real fix.

Env already set: `CRON_SECRET`, `BINDINGS_KEY`, `OPERATOR_EMAIL`.

### What Tyler has to do (I can't from here)

| Need | Why | How |
|---|---|---|
| **Connect the GitHub repo in Vercel** | The project was created with the git link but no deployment fired — the Vercel GitHub app isn't authorized on `The-Ops-King/backend-in-a-box`. | Vercel → project → Settings → Git → Connect. After that every push to `main` deploys. |
| **`DATABASE_URL`** | No database in production yet. | Vercel → Storage → create Postgres (Neon). It injects `DATABASE_URL` automatically. Then run `pnpm db:migrate` once against it (locally with the URL, or from a one-off script). |
| **`JEV_API_KEY`** (optional for MVP) | Without it every reply classifies as `unclear` → the human path. Safe, just not smart. | TypeSafe AI account → key → Vercel env. The request shape in `src/adapters/jev/classifier.ts` is unverified against their docs — one function to fix. |
| **A GHL phone number per sub-account** | SMS sends return `No numbers available in the account`. Email works without it. | Buy a number in each sub-account once A2P is approved. |
| **Slack** (later) | `slack_post` nodes skip with a warning until a workspace is connected. | OAuth flow isn't built; `slack_connections` table is ready for it. |

Once the repo is connected and `DATABASE_URL` exists: push → deploy → migrate → install a company
→ the cron takes it from there. `/api/health` should return `{ok:true, companies:N}`.

## Not built yet (deliberately)

Dashboard and visual editor · hosted forms (intake/disposition/EOD) · Slack OAuth · opportunity
polling from GHL (ours are rule-driven) · command center · template drift tooling · attribute
reclassification. All designed in `../engine/`, none blocking the first client.

## Known gaps worth knowing

- Email bodies in `sends.rendered_body` are stored (they're ours); GHL email *replies* store
  metadata only.
- `relative:auto` rounding and the formatter are tested; cross-DST edge cases aren't yet.
- Vercel Auth (SSO protection) is on for deployment URLs; the cron is internal so it's fine, but
  hitting `/api/health` from a browser needs a bypass token or a custom domain.
- The reminder template's closer name is `split_part(users.name, ' ', 1)` — a user literally
  named "Closer One" renders as "Closer".
