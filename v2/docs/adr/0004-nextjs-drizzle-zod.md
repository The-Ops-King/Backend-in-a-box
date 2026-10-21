# 0004. Next.js and React; Drizzle and Zod

Date: 2026-10-21. Decided by Tyler (Next.js), with Claude's recommendation (Drizzle and Zod).

**Decision.**
- One TypeScript app on Next.js and React, for the API and the dashboard. The worker shares its code.
- Tables are declared in TypeScript with Drizzle, and migrations are generated from those declarations and numbered.
- Zod schemas check every workflow definition, setting and inbound payload before it is saved or used.

**Why.** Tyler knows JavaScript and React. Typed tables and schemas end the hand-written SQL strings and the parser drift of
the old system: four boolean parsers, three phone normalizers.
