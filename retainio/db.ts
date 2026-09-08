import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Single shared Prisma client for server.ts, using the pooled connection
// (DATABASE_URL) — migrations use DIRECT_URL via prisma.config.ts instead.
const adapter = new PrismaPg(process.env.DATABASE_URL!);

export const prisma = new PrismaClient({ adapter });
