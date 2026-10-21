# Backend in a Box v2

The rebuild, from scratch, next to the system it replaces. The plan is `../engine/15-rebuild-plan.md`. The design is the
blueprint (claude.ai/artifact/MP4tBRF9c59ofKw7mGPQB8), plus the GHL Marketplace App Spec and the Platform Slack App Spec.

- **The old system** (`../platform/`) keeps running the live offers. It is never edited from the rebuild branches.
- **What the new system must do** is in `../spec/<offer>/`: each offer's workflows, step by step, with real runs as traces.
- **Decisions** are short records in `docs/adr/`, one per decision. Code comments describe behavior, not decision numbers.

Current phase: **0, decisions and checks** (`docs/phase-0.md`).
