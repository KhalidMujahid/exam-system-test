require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

async function main() {
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!password || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Set ADMIN_INITIAL_PASSWORD to at least 12 characters and at most 72 UTF-8 bytes.');
  }
  const prisma = new PrismaClient();
  try {
    const value = await bcrypt.hash(password, 12);
    await prisma.setting.upsert({ where: { key: 'adminPasswordHash' }, update: { value }, create: { key: 'adminPasswordHash', value } });
    console.log('Admin password updated. Restart the application to invalidate existing sessions.');
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
