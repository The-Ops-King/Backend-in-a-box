# 0002. One host: Railway, for the app, the worker and Postgres

Date: 2026-10-21. Decided by Tyler ("as few as possible for now ... we can do railway").

**Decision.** v2 runs on Railway alone:
- the Next.js app (API and dashboard);
- one always-on worker;
- Postgres.

v2 uses no Vercel and no Supabase. The old system stays on them until each offer moves.

**Why.**
- An always-on worker keeps its database awake, so free tiers that sleep or cap compute do not fit:
  - Neon Free stops compute at 100 CU-hours a month;
  - Supabase's free projects are used up, and its preview branches are paid;
  - Vercel Hobby is for non-commercial use only.
- One provider means one bill, one dashboard and one place to look.

**Consequences.** Expect roughly $5 to $15 a month at today's size; check it against Railway's pricing. The database is plain
Postgres, so it can move.
