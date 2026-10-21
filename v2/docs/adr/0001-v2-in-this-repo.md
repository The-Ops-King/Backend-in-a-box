# 0001. v2 lives in this repository

Date: 2026-10-21. Decided by Tyler.

**Decision.** The rebuild is the `v2/` folder of this repository, on its own branches (`rebuild` and branches cut from it).
It is not a new repository.

**Why.** The spec and golden traces (`spec/`) and the old code (`platform/`) are what v2 is tested against. Keeping them in the
same tree lets v2's tests read the traces directly.

**Consequences.** Nothing on a rebuild branch edits `platform/`. Fixes to the old system go on their own branches, as now.
