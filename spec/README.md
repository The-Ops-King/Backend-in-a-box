# Behavior spec

What every offer's workflows do, step by step, generated from their definitions so it cannot drift from them. Each
`spec/<offer>/README.md` lists the offer's workflows; each `spec/<offer>/<workflow>.md` shows every step in run order with its
exact words, conditions, waits, failure behaviour and exits, the settings it reads, and the engine rules that act on it
without being a step. `spec/<offer>/traces/` holds golden traces: real runs, with every person replaced by a pseudonym.

| Command (in `platform/`) | What it writes |
| --- | --- |
| `pnpm spec` | The spec from the repo (installs and shipped templates). Marked "from repo, may differ from live". |
| `pnpm spec --from db [offer…]` | The spec from each offer's current saved versions. Needs `SPEC_DATABASE_URL`. |
| `pnpm traces [--per-path N] [offer…]` | Up to N (default 5) recent runs per workflow for each way a run ended. Needs `SPEC_DATABASE_URL`. |

`SPEC_DATABASE_URL` is a read-only role. It needs only `select`, and reads every offer by setting `app.role = operator` on its
own session, which the tenant policy allows. It never reads a secret's value.

```sql
create role spec_reader login password '<generated>';
grant usage on schema public to spec_reader;
grant select on all tables in schema public to spec_reader;
alter role spec_reader set default_transaction_read_only = on;
```

The repo has install files for PMU and Dating (Nelly) only. Hair's workflows exist only in the database.
