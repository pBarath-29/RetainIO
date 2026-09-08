# Archived one-shot scripts

These have already run against the live database and are kept only as a record
of how the data got into its current shape. **Do not run them again** — several
are actively destructive if repeated.

`prisma/migrations/` records every *schema* change. These scripts record the
*data* changes that went with them, which migrations don't capture.

| Script | What it did | Why re-running is unsafe |
|---|---|---|
| `seed-phase2.ts` | Turned `mockData.ts`'s hand-typed `riskHistory` arrays into 6 months of `fusion_scores` + `churn_predictions` per account | Would duplicate the entire fusion history |
| `backfill-real-fusion.ts` | Added one genuinely model-computed fusion point per account, replacing the approximated "current" value | Creates a second row for today, violating the `(accountId, snapshotDate)` design |
| `migrate-fusion-to-monthly.ts` | Rolled existing `fusion_scores` up into the then-new `fusion_monthly_summaries` | Rollups are now maintained continuously by `fusionSnapshot.ts` |
| `backfill-sentiment-risk-weight.ts` | Filled `risk_weight` on sentiment rows written before that column existed | No rows lack it now |
| `migrate-faces-to-db.ts` | Moved face enrolments off `model_service/face_data/*.png` into `face_samples` as embeddings | The source directory no longer exists |
| `consolidate-managers.ts` | Reduced four seeded Account Managers to two and redistributed all 9 accounts | Would try to delete users who no longer exist |
| `remove-marcus.ts` | Deleted the seeded Account Director "Marcus Vance" | Target already gone |
| `realign-audit-approvers.ts` | Re-pointed seeded audit logs and discount requests at each account's own manager | Those rows have since been wiped entirely |
| `normalise-audit-actions.ts` | Rewrote free-hand seeded action strings into the format `buildActionLabel` generates | Same — the rows are gone |

## Still active, in `prisma/`

| Script | Purpose |
|---|---|
| `seed.ts` | Bootstraps an **empty** database: users, accounts, subscriptions, usage, tickets. The only definition of that data outside the live database — needed for a new deployment, a reset Supabase project, or a fresh clone. Deliberately seeds **no** discount requests or audit logs. |
| `seed-admin.ts` | Creates the admin login and assigns Managers to a Director. Idempotent. |
| `seed-sentiment.ts` | Runs every stored ticket through the real sentiment model. |
| `run-daily-snapshot.ts` | Manual trigger for the daily fusion snapshot the server otherwise runs itself. |
| `backfill-shap-latest.ts` | Regenerates real SHAP factors for each account's current prediction (`--force` to overwrite). |
| `wipe-discount-activity.ts` | Clears all discount requests and audit logs, back to "nothing has happened". |
