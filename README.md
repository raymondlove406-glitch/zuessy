# HashVault full-stack starter

A Node.js + Express + PostgreSQL + Prisma starter for a mining account portal. It includes registration/login, referral attribution, account dashboard, payout review requests, admin queue, and audit logs.

## Important scope and safety

This is a **development starter**, not a production-ready financial service. Mining records are not automatically generated, there is no mining-pool integration, and payout requests do **not** transfer funds. Admin approval only changes the request status. The demo UI must not be represented as proof of live mining, guaranteed earnings, or completed payments.

Before real-money launch:
- Obtain legal/compliance review for the jurisdictions and assets involved.
- Integrate a reputable mining pool/provider and verify signed/webhook events server-side.
- Use a dedicated wallet custody/signing provider or audited HSM/MPC setup; never store private keys in this app or expose them to browsers.
- Add a ledger with immutable entries, balance reservations, idempotency keys, reconciliation, withdrawal limits, risk checks, and dual-control approval.
- Require MFA for admins and sensitive account actions; add recovery controls and session revocation.
- Add CSRF protection tests, security headers/CSP review, dependency scanning, backups, monitoring, incident response and external penetration testing.
- Configure HTTPS, secure cookies, secrets management, least-privilege database roles and production logging.
- Do not calculate payable balances from client input. The server must derive balances from verified provider data and ledger entries.

## Requirements

- Node.js 20+
- PostgreSQL 14+

## Setup

1. Create a PostgreSQL database named `hashvault`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, a random `SESSION_SECRET` (32+ characters), `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD` (16+ characters).
3. Install dependencies:

   ```bash
   npm install
   ```

4. Generate Prisma client and create tables:

   ```bash
   npm run db:generate
   npm run db:migrate
   ```

5. Create the administrator account:

   ```bash
   npm run db:seed
   ```

6. Start the app:

   ```bash
   npm run dev
   ```

7. Open `http://localhost:3000`.

## Main API routes

- `GET /api/csrf` — session-bound CSRF token
- `POST /api/auth/register` — create account; optional referral code
- `POST /api/auth/login` — sign in
- `POST /api/auth/logout` — sign out
- `GET /api/me` — current account
- `GET /api/dashboard` — account metrics and payout history
- `GET /api/referrals` — referral records
- `POST /api/payouts` — create manual-review request (no transfer)
- `GET /api/admin/overview` — admin-only overview
- `GET /api/admin/payouts` — admin-only payout queue
- `PATCH /api/admin/payouts/:id` — admin-only status change

## Data model

- `User`: account, role, unique referral code and referrer relation
- `MiningSnapshot`: server-recorded mining metrics with source label
- `Payout`: request, destination, status and optional transaction reference
- `AuditLog`: administrative and account event history

## Production deployment notes

Run behind HTTPS with `NODE_ENV=production`, a strong session secret from a secrets manager, and a restricted database account. Set `APP_ORIGIN` to the exact production origin if adding origin checks. Add a strict Content Security Policy after reviewing any required assets. Use a managed PostgreSQL service with automated backups. Run migrations as a deployment step, not at every app startup.
