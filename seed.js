require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 16) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (16+ characters) before seeding.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: "ADMIN" },
    create: {
      email,
      passwordHash,
      role: "ADMIN",
      referralCode: "HVADMIN" + Math.random().toString(36).slice(2, 7).toUpperCase()
    }
  });
  console.log("Admin account seeded.");
}

main().catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
