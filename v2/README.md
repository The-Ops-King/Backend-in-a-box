# Backend in a Box v2

The rebuild, from scratch, next to the system it replaces. The plan is `../engine/15-rebuild-plan.md`. The design is the
blueprint (claude.ai/artifact/MP4tBRF9c59ofKw7mGPQB8), plus the GHL Marketplace App Spec and the Platform Slack App Spec.

- **The old system** (`../platform/`) keeps running the live offers. It is never edited from the rebuild branches.
- **What the new system must do** is in `../spec/<offer>/`: each offer's workflows, step by step, with real runs as traces.
- **Decisions** are short records in `docs/adr/`, one per decision. Code comments describe behavior, not decision numbers.

Current phase: **0, decisions and checks** (`docs/phase-0.md`).

## What is here now
The GHL recorder, for the Phase 0 checks. It becomes v2's GHL door later.

| Route | What it does |
| --- | --- |
| `POST /in/ghl` | Takes every GHL webhook. It checks GHL's Ed25519 signature, stores the delivery raw in `inbox` once (a retry is the same row), and answers 200. A bad signature gets 401 and is kept nowhere. |
| `GET /ghl/oauth/callback` | Where GHL sends the installer. It exchanges the code for the location's tokens and stores them sealed in `ghl_connections`, marked for Tyler to link to an offer. |
| `GET /health` | Answers when the app is up. |

The workflow definition format (`src/workflow/`): the ten versioned primitives, the action registry, conditions, the
template renderer with blank detection, and `validateWorkflow`. There is no interpreter yet. How each v1 step is written in
it is in `docs/v1-to-v2-steps.md`.

## Deploy on Railway (from the repo)
1. **New project, then Deploy from GitHub repo.** Pick this repository and the branch `rebuild`. In the service's settings, set
   **Root Directory** to `v2`. `railway.json` holds the build and start commands; the start command runs the migrations first.
2. **Add a database.** In the same project, click New, then Database, then PostgreSQL.
3. **Set the service's variables:**
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`, Railway's reference to the database.
   - `TOKEN_KEY`: 32 random bytes as base64, for example the output of `openssl rand -base64 32`. Keep it only here.
   - `GHL_WEBHOOK_PUBLIC_KEY`: GHL's webhook public key, the PEM text from GHL's webhook authentication docs.
   - `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET`: from the GHL app once it exists.
   - `GHL_REDIRECT_URI`: `https://<the service's Railway domain>/ghl/oauth/callback`.
4. **Generate a domain** under the service's Networking settings. Then check that `https://<domain>/health` answers
   `{"ok":true}`.

The GHL app takes two URLs:
- redirect URL: `https://<domain>/ghl/oauth/callback`
- webhook URL: `https://<domain>/in/ghl`

## Develop
`pnpm install`, then:
- `pnpm test` (it needs `DATABASE_URL` pointing at an empty Postgres);
- `pnpm typecheck`;
- `pnpm db:generate` after a change to `src/db/schema.ts`. That writes the next numbered migration into `drizzle/`.
