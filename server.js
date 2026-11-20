require("dotenv").config();
const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { z } = require("zod");

const app = express();
const prisma = new PrismaClient();
const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 characters.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public"));

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
app.set("trust proxy", isProd ? 1 : false);
app.use(session({
  store: new connectPgSimple({ pool: pgPool, createTableIfMissing: true }),
  name: "hv.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false });
app.use("/api", apiLimiter);

function csrfToken(req, res) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString("hex");
  res.json({ csrfToken: req.session.csrf });
}
app.get("/api/csrf", csrfToken);

function requireCsrf(req, res, next) {
  const token = req.get("x-csrf-token");
  const saved = req.session.csrf;
  if (!token || !saved || token.length !== saved.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(saved))) {
    return res.status(403).json({ error: "Invalid or missing CSRF token." });
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Authentication required." });
  next();
}
function requireAdmin(req, res, next) {
  if (req.session.user?.role !== "ADMIN") return res.status(403).json({ error: "Administrator access required." });
  next();
}
function audit(actorId, action, entityType, entityId, metadata) {
  return prisma.auditLog.create({ data: { actorId, action, entityType, entityId, metadata } });
}
function publicUser(user) {
  return { id: user.id, email: user.email, role: user.role, referralCode: user.referralCode };
}
function makeReferralCode() {
  return "HV" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

app.post("/api/auth/register", authLimiter, requireCsrf, async (req, res) => {
  const schema = z.object({
    email: z.string().email().max(254),
    password: z.string().min(12).max(128),
    referralCode: z.string().trim().max(32).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and a password of at least 12 characters." });

  try {
    const email = parsed.data.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "An account with this email already exists." });

    const referrer = parsed.data.referralCode
      ? await prisma.user.findUnique({ where: { referralCode: parsed.data.referralCode } })
      : null;
    if (parsed.data.referralCode && !referrer) return res.status(400).json({ error: "Referral code not found." });

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(parsed.data.password, 12),
        referralCode: makeReferralCode(),
        referredById: referrer?.id
      }
    });
    await audit(user.id, "USER_REGISTERED", "User", user.id, { referred: Boolean(referrer) });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not start session." });
      req.session.user = publicUser(user);
      req.session.csrf = crypto.randomBytes(32).toString("hex");
      req.session.save(() => res.status(201).json({ user: publicUser(user), csrfToken: req.session.csrf }));
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/auth/login", authLimiter, requireCsrf, async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid email or password." });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  const valid = user && await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password." });

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start session." });
    req.session.user = publicUser(user);
    req.session.csrf = crypto.randomBytes(32).toString("hex");
    req.session.save(() => res.json({ user: publicUser(user), csrfToken: req.session.csrf }));
  });
});

app.post("/api/auth/logout", requireAuth, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("hv.sid", { httpOnly: true, sameSite: "lax", secure: isProd });
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.session.user }));

app.get("/api/dashboard", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const [latest, referralCount, payouts] = await Promise.all([
    prisma.miningSnapshot.findFirst({ where: { userId }, orderBy: { recordedAt: "desc" } }),
    prisma.user.count({ where: { referredById: userId } }),
    prisma.payout.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 10 })
  ]);
  res.json({
    user: req.session.user,
    mining: latest ? {
      hashRateTh: Number(latest.hashRateTh),
      grossUsd: Number(latest.grossUsd),
      serviceFeeUsd: Number(latest.serviceFeeUsd),
      operatingUsd: Number(latest.operatingUsd),
      netUsd: Number(latest.netUsd),
      source: latest.source,
      recordedAt: latest.recordedAt
    } : null,
    referralCount,
    payouts
  });
});

app.get("/api/referrals", requireAuth, async (req, res) => {
  const referrals = await prisma.user.findMany({
    where: { referredById: req.session.user.id },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json({ referralCode: req.session.user.referralCode, referrals });
});

app.post("/api/payouts", requireAuth, requireCsrf, async (req, res) => {
  const parsed = z.object({
    amountUsd: z.number().positive().max(100000),
    destination: z.string().trim().min(8).max(160)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid amount and destination." });

  // Demo safeguard: requests are queued for manual review; no funds are transferred.
  const payout = await prisma.payout.create({
    data: { userId: req.session.user.id, amountUsd: parsed.data.amountUsd, destination: parsed.data.destination }
  });
  await audit(req.session.user.id, "PAYOUT_REQUESTED", "Payout", payout.id, { amountUsd: parsed.data.amountUsd });
  res.status(201).json({ payout, message: "Request queued for review. No transfer has been made." });
});

app.get("/api/admin/overview", requireAuth, requireAdmin, async (req, res) => {
  const [users, pendingPayouts, recentAudit] = await Promise.all([
    prisma.user.count(),
    prisma.payout.count({ where: { status: "REQUESTED" } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 20 })
  ]);
  res.json({ users, pendingPayouts, recentAudit });
});

app.get("/api/admin/payouts", requireAuth, requireAdmin, async (req, res) => {
  const payouts = await prisma.payout.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
    take: 100
  });
  res.json({ payouts });
});

app.patch("/api/admin/payouts/:id", requireAuth, requireAdmin, requireCsrf, async (req, res) => {
  const parsed = z.object({
    status: z.enum(["APPROVED", "REJECTED", "PAID"]),
    transactionHash: z.string().trim().min(8).max(180).optional(),
    adminNote: z.string().trim().max(500).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payout update." });
  if (parsed.data.status === "PAID" && !parsed.data.transactionHash) {
    return res.status(400).json({ error: "A verified transaction reference is required to mark paid." });
  }

  const payout = await prisma.payout.findUnique({ where: { id: req.params.id } });
  if (!payout) return res.status(404).json({ error: "Payout not found." });
  if (payout.status === "PAID" || payout.status === "REJECTED") {
    return res.status(409).json({ error: "This payout is already closed." });
  }

  const updated = await prisma.payout.update({
    where: { id: payout.id },
    data: {
      status: parsed.data.status,
      transactionHash: parsed.data.transactionHash,
      adminNote: parsed.data.adminNote
    }
  });
  await audit(req.session.user.id, "PAYOUT_STATUS_CHANGED", "Payout", payout.id, { status: parsed.data.status });
  res.json({ payout: updated });
});

app.get("/api/health", (req, res) => res.json({ ok: true, mode: "demo", timestamp: new Date().toISOString() }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(port, () => console.log(`HashVault running on http://localhost:${port}`));

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  await pgPool.end();
  process.exit(0);
});
