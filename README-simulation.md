# Keeping the simulated telemetry current

The usage readings in this project are **generated, not measured**. `simulate-usage.ts`
invents them, because every account otherwise had exactly one usage snapshot and nothing
ever changed — the churn model scored identical inputs forever and the trend charts drew
flat lines. This must be stated as simulated wherever the project is written up.

## How it advances

`SIMULATE_USAGE=true` is set in `retainio/.env`. On every server start, and every six hours
it stays open, the app fills each account forward to today and scores each filled day
through the real churn → sentiment → fusion chain.

```
cd model_service && python -m uvicorn app:app --port 8000
cd retainio && npm run dev
```

Nothing is scheduled and nothing runs in the background on its own: the telemetry advances
when you open the app, and not otherwise.

## Why the gaps between sessions do not matter

The pass fills every day between an account's last reading and today, not just today. Leave
the project alone for a week, open it, and the whole week is filled in and scored.

An earlier version advanced exactly one day, which meant every day you did not open the app
stayed blank permanently — the next run saw the account as already current and never went
back for it.

The same trap applies when the model service is down, because a day's usage row is written
before its score is attempted. So the pass now checks `/health` first and writes **nothing**
if the service is unreachable, logging why. A skipped day is repaired the next time you open
the app; an unscored day would never be repaired at all.

## Undoing all of it

Every row the simulator creates is recorded by id in `retainio/prisma/.simulation-manifest.json`.

```
cd retainio && npx tsx prisma/simulate-usage.ts reset
```

deletes exactly those ids and rebuilds the monthly rollups, leaving the 9 real seeded usage
snapshots and 117 real fusion scores untouched. Without the manifest a reset would have to
guess which rows were simulated, and guessing wrong destroys model output that cannot be
regenerated.

## Commands

```
npx tsx prisma/simulate-usage.ts status      # what exists now, and the manifest count
npx tsx prisma/simulate-usage.ts backfill    # 180 days of history, backwards from today
npx tsx prisma/simulate-usage.ts catchup     # fill from the last reading to today
npx tsx prisma/simulate-usage.ts reset       # remove exactly what was generated
```
