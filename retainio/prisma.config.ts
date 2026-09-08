import { defineConfig, env } from 'prisma/config';
import 'dotenv/config';

// Prisma 7 moved connection URLs out of schema.prisma and into this file.
// Migrations run through DIRECT_URL (the non-pooled, session-mode connection) —
// the pooled DATABASE_URL is what the running app uses instead, wired up
// separately via a driver adapter when we build the PrismaClient in server.ts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DIRECT_URL'),
  },
});
