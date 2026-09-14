# RetainIO web app

The React front end and the Express API that serves it. See the [project README](../README.md) for
what RetainIO does, how the parts fit together, the models, and the logins.

## Run

```bash
npm install
cp .env.example .env        # every setting is explained in the file
npx prisma migrate deploy
npm run dev                 # http://localhost:3000; the model service must be running on :8000
```

`npm run lint` type-checks. `npm run build` then `npm start` (with `NODE_ENV=production`) runs the
production build.

## Scripts

All run from this folder with `npx tsx prisma/<script>`.

| Script | What it does |
|---|---|
| `seed.ts` | Fills an empty database: the nine demo accounts and two Account Managers |
| `seed-admin.ts` | The admin login, and links both Managers to the Director once one has signed up |
| `seed-historical-cases.ts` | The past cases the AI advisor searches |
| `set-password.ts <email> <password>` | Gives a user a password, e.g. a seeded Manager |
| `set-contact-emails.ts` | Gives every account a contact email for offer emails (address from `.env`) |
| `demo-renewal.ts create` / `remove` | Throwaway accounts whose renewals have already passed |
| `check-inbox.ts` | Runs one inbox check by hand |
| `run-daily-snapshot.ts` | Runs the daily re-score by hand |
| `export-renewal-outcomes.ts` | Writes renewal outcomes and sentiment corrections to `../Datasets/feedback/` for retraining |
