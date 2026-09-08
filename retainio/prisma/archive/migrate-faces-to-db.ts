import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// One-shot: moves face enrolments off the filesystem and into Postgres.
//
// The old layout wrote cropped PNGs to model_service/face_data/<user id>/,
// which doesn't survive a redeploy on a host with an ephemeral filesystem —
// every Director would silently lose the ability to approve. Each image is
// re-embedded through model_service's /face/embed and stored as a vector in
// face_samples; the images themselves are then redundant.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });
const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';
// Resolved from the repo root rather than __dirname — this runs as an ES
// module, where __dirname isn't defined.
const FACE_DATA_DIR = path.resolve(process.cwd(), '..', 'model_service', 'face_data');

async function main() {
  if (!fs.existsSync(FACE_DATA_DIR)) {
    console.log('No face_data directory — nothing to migrate.');
    return;
  }

  let migrated = 0;
  for (const userId of fs.readdirSync(FACE_DATA_DIR)) {
    const dir = path.join(FACE_DATA_DIR, userId);
    if (!fs.statSync(dir).isDirectory()) continue;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      console.warn(`Skipping ${userId} — no such user (orphaned folder).`);
      continue;
    }

    const existing = await prisma.faceSample.count({ where: { userId } });
    if (existing > 0) {
      console.log(`${user.name}: already has ${existing} sample(s) in the DB, skipping.`);
      continue;
    }

    for (const file of fs.readdirSync(dir)) {
      const dataUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(dir, file)).toString('base64');
      const res = await fetch(`${MODEL_SERVICE_URL}/face/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.warn(`  ${file}: ${data.error}`);
        continue;
      }
      await prisma.faceSample.create({ data: { userId, embedding: data.embedding } });
      console.log(`  ${file} -> stored ${data.embedding.length}-d embedding`);
      migrated++;
    }

    await prisma.user.update({ where: { id: userId }, data: { faceEnrolledAt: new Date() } });
    console.log(`${user.name}: migrated.`);
  }

  console.log(`\nMigrated ${migrated} face sample(s) into Postgres.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
