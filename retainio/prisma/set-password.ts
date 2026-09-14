import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../db';

/**
 * Sets a user's password. Mainly for the two seeded Account Managers, whom seed.ts creates
 * without one.
 *
 *   npx tsx prisma/set-password.ts sarah.jenkins@retain.io "a new password"
 *
 * Signup is for Directors only, and the admin page creates new users rather than editing
 * existing ones, so on a fresh install this is how a seeded Manager gets a login.
 */
const [email, password] = process.argv.slice(2);

if (!email || !password || password.length < 8) {
  console.log('Usage: npx tsx prisma/set-password.ts <email> <password of at least 8 characters>');
} else {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) {
    console.log(`No user has the email ${email}.`);
  } else if (user.role === 'system') {
    // The actor named on automatic audit rows; it must never be able to sign in.
    console.log('The system actor cannot have a password.');
  } else {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 12) } });
    console.log(`Password set for ${user.name} <${user.email}>.`);
  }
}

await prisma.$disconnect();
