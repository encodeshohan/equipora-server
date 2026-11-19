# Equipora (server)

Express 5 REST API for **Equipora**, an equipment rental marketplace. It handles equipment, favorites, bookings, Stripe payments, admin management and analytics.

- **Live API:** https://equipora-server-encodeshohan.vercel.app
- **Client repo:** https://github.com/encodeshohan/equipora
- **Live site:** https://equipora-encodeshohan.vercel.app

## Tech stack

Node.js (ES modules), Express 5, MongoDB driver 7, Stripe, `cors`, `dotenv`. The whole API lives in `index.js`.

## Getting started

Requirements: Node.js 20 or newer and the same MongoDB Atlas database the client uses (`equiporadb`).

```bash
git clone https://github.com/encodeshohan/equipora-server.git
cd equipora-server
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

The API runs on http://localhost:5000.

### Environment variables

Create `.env` (never commit it):

| Key | Purpose |
|---|---|
| `PORT` | Port (default `5000`). Leave unset on Vercel |
| `MONGODB_URI` | Atlas connection string for `equiporadb`. Must match the client's |
| `CLIENT_URLS` | Comma-separated browser origins allowed by CORS (`http://localhost:3000`, then the live client URL) |
| `CLIENT_URL` | The client URL used in Stripe success and cancel redirects |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` in test mode) |
| `STRIPE_CURRENCY` | Charge currency, default `bdt` |
| `STRIPE_BDT_PER_UNIT` | Only needed when the currency is not BDT: taka per 1 unit of that currency |

If Stripe is not configured, booking and payment routes return `503` and the rest of the API still works.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (`node --watch`) |
| `npm start` | Start normally |
| `node scripts/seed-equipment.js` | Insert 21 sample listings (18 approved, 2 pending, 1 rejected) for the owner named by `SEED_OWNER_EMAIL` (set it in the shell or `.env`). Re-running replaces earlier seed data |
| `node scripts/seed-equipment.js --clean` | Remove the seeded equipment |
| `node scripts/clean-probe-data.js` | Remove test users (`@test.dev`), their sessions, bookings and favorites |
| `node scripts/clean-users.js` | Dry run: show what would be deleted when keeping only the test admin. Add `--confirm` to apply (**irreversible**) |
| `node scripts/dev-fixtures.js` | Local testing only: creates fake users and sessions. **Do not run against a production database** |

## Authentication and roles

The client signs users in with better-auth. Every protected request sends `Authorization: Bearer <session token>`. The server looks the token up in the `session` collection, checks that it hasn't expired, loads the user from the `user` collection and rejects suspended accounts. Middleware: `verifyToken`, then `verifyRenter` (role `customer`), `verifyOwner` or `verifyAdmin`.

Security rules used across the API:

- The user id always comes from the verified token, never from the request body.
- Every mutation checks the role and, where it matters, ownership of the record.
- Invalid ObjectIds and missing records return `400` and `404` instead of crashing.
- Request fields are whitelisted and validated. Query params accept plain strings only (operator-injection safe), and search text is escaped before it reaches a regex.
- The booking total is computed on the server from the stored price. Stripe prices use `price_data`, never hardcoded price IDs.
- Payment verification requires the logged-in customer to own the Stripe session, checks the paid amount against the booking, and uses a unique index on `payments.sessionId` to block replays.
- Auth headers are never logged. CORS allows only the origins in `CLIENT_URLS`.

## Collections

`user`, `session` (better-auth), `equipment`, `bookings`, `favorites`, `payments`.

Booking lifecycle: created as `pending` and `unpaid`, then `paid` and `confirmed` after Stripe verification. Availability counts confirmed bookings plus unpaid holds younger than 35 minutes, using the peak overlap over the requested dates.

## API overview

**Public**

| Method | Route | Notes |
|---|---|---|
| GET | `/` | Health check |
| GET | `/equipment` | Approved equipment. Query: `search`, `category` (name or slug), `rentalType`, `minPrice`, `maxPrice`, `availability` (`available` or `unavailable`), `sort` (`newest`, `price-asc`, `price-desc`), `page`, `limit` (max 24) |
| GET | `/equipment/featured` | 6 newest approved items |
| GET | `/equipment/categories` | Categories with live counts |
| GET | `/equipment/:id` | One approved item |

**Any logged-in user:** `GET /me`, `GET /profile`, `PATCH /profile` (name, image, phone, address only), `GET /equipment/:id/manage` (owner of the item or admin).

**Customer:** `GET /favorites`, `GET /favorites/ids`, `POST /favorites`, `DELETE /favorites/:equipmentId`, `POST /bookings/checkout`, `GET /bookings/mine`, `POST /payments/checkout-verify`.

**Owner:** `POST /equipment`, `GET /owner/equipment`, `GET /owner/bookings` (paid bookings of their equipment), `GET /owner/analytics`.

**Owner or admin (own record or admin):** `PATCH /equipment/:id`, `DELETE /equipment/:id`. Owner edits send the item back to `pending`. Deletes are blocked while the item has active bookings.

**Admin:** `GET /admin/equipment`, `PATCH /equipment/:id/status`, `GET /admin/users`, `PATCH /admin/users/:id/role`, `PATCH /admin/users/:id/ban`, `GET /admin/bookings`, `GET /admin/analytics`.

Analytics count paid bookings only, grouped by month (last 6 months) in Bangladesh time. Revenue and earnings are gross amounts paid by customers.

## Known limitations

- No scheduled job moves bookings to `completed` after their end date, so completed-rental counts stay at 0.
- No Stripe webhook: payments are confirmed when the customer returns to the success page (or presses Check payment in My Rentals).
- No email notifications.

## Deployment (Vercel)

Vercel detects Express from the root `index.js`, so no extra config is needed. Add the environment variables above (do not set `PORT`), allow `0.0.0.0/0` in Atlas Network Access, and set `CLIENT_URL` and `CLIENT_URLS` to the live client URL.