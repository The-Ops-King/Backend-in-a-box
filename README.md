# Backend in a Box

A complete sales operations backend, built once and deployed per client.

## What's here

| Path | What it is |
|---|---|
| `ghl/` | The GoHighLevel build: verified API behaviour, the data-layer build script, and what has to be done by hand |
| `proposals/` | Client proposals, source and rendered |
| `VOICE.md` | Writing guide for anything client facing |

## Start here

- `ghl/00-state.md` is the live inventory of what exists in the template sub-account, with every field key and ID
- `ghl/02-api-facts.md` is what the GHL API will and won't do, tested rather than taken from the docs
- `ghl/05-gap-inventory.md` is everything still outstanding
- `ghl/build-backend.sh` builds the whole data layer into a fresh sub-account

## Building into a new sub-account

```bash
export GHL_PIT='pit-...'     # created inside the target sub-account
export GHL_LOC='...'         # that sub-account's location id
./ghl/build-backend.sh
```

The script is idempotent. It checks before creating, so re-running it is safe.

A PIT is scoped to one sub-account. A new sub-account needs a new PIT.

## What the script does not build

Workflows, forms, and smart lists have no create endpoint in the GHL API. Those are hand-built once and travel in the snapshot. See `ghl/03-manual-steps.md`.
