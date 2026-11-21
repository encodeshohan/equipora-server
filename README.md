# 🖥️ EQUIPORA Server — Rental Marketplace API

Express 5 and MongoDB API for the Equipora equipment rental marketplace.

🌐 **Live Website:** [Equipora](https://equipora-encodeshohan.vercel.app/) <br>
🔌 **Live API:** [equipora-server](https://equipora-server-encodeshohan.vercel.app/) <br>
📦 **Backend Repository:** [encodeshohan/equipora-server](https://github.com/encodeshohan/equipora-server) <br>
🎨 **Frontend Repository:** [encodeshohan/equipora](https://github.com/encodeshohan/equipora)

---

## 🌐 Project Overview

**Equipora Server** is the REST API behind the Equipora rental marketplace. It stores equipment, favorites, bookings and payments, and it decides who is allowed to create, change, book or approve them.

The frontend signs users in with Better Auth and sends a JWT in the `Authorization: Bearer <token>` header. This server verifies that token against the frontend's public keys at `/api/auth/jwks`, so it never handles passwords or sessions itself.

---

## 🛠️ Technologies Used

### Backend

- 🟢 **Node.js** — ES modules runtime
- 🚂 **Express 5** — Routing and error handling for async handlers
- 🍃 **MongoDB** — Database for equipment, bookings, favorites and payments

### Libraries

- 🔐 **jose** — JWT verification using a remote JWKS
- 💳 **Stripe** — Checkout sessions and payment verification
- 🌍 **cors** — Locks the API to the Equipora frontend origins
- ⚙️ **dotenv** — Environment variable loading

### Hosting

- ▲ **Vercel** — Serverless deployment
- 🗄️ **MongoDB Atlas** — Hosted database

---

## ✨ Features

### 1. 🔐 Secure JWT Authentication

- Verifies tokens with the frontend's public keys (JWKS)
- Checks the token issuer and audience against `CLIENT_URL`
- Loads the user from the database on every request, so roles and suspensions are always current
- Suspended accounts get 403, and suspending a user also logs them out everywhere
- Role guards for customer, owner and admin routes

### 2. 🔎 Public Equipment Listing

- Returns approved equipment only, and never exposes owner emails
- Search by name, location or category
- Filter by category (name or slug), rental type, price range and availability
- Sort by newest, price low to high or price high to low
- Pagination with `limit` clamped between 1 and 24
- Safe, escaped search patterns, so user input can never act as a regex
- Query values must be plain strings, which blocks operator injection
- Featured items and categories with live counts

### 3. 🛠️ Equipment Management with Ownership Checks

- Owners create equipment, and every new listing starts as `pending`
- Only the owner or an admin can edit or delete a listing (403 otherwise)
- Owner edits send the listing back to `pending`, and admin edits keep the current status
- Admins approve or reject listings
- Owner name, email and photo are taken from the verified token, never from the request body
- A listing with active bookings cannot be deleted (409)
- Deleting a listing also removes it from every favorites list

### 4. ❤️ Favorites

- Customers save and remove approved equipment
- A unique index blocks duplicate favorites, so double clicks are harmless
- Favorites list only shows items that are still approved

### 5. 📅 Smart Bookings and Availability

- Validates dates, quantity, contact number and delivery address
- Start date cannot be in the past, and rentals are limited to 365 days
- Availability counts confirmed bookings plus unpaid holds younger than 35 minutes, using the peak overlap across the requested dates
- A race guard re-checks availability after saving and removes the booking if another customer won
- The total is always calculated on the server from the stored price, with weekly and monthly rentals rounded up

### 6. 💳 Stripe Payments with Replay Protection

- Creates Stripe Checkout Sessions with `price_data`, never hardcoded price IDs
- Supports BDT directly, or another currency with a conversion rate
- Payment verification requires the logged-in customer to own the Stripe session
- Checks the paid amount and currency against the booking
- A unique index on `payments.sessionId` blocks replays, and verifying twice is safe
- If Stripe is not configured, payment routes return 503 and the rest of the API keeps working

### 7. 🛡️ Admin Tools and Analytics

- Admins list users, change roles and suspend or restore accounts
- Admins cannot change or suspend their own account, or suspend another admin
- Admins see every booking, with payment and booking status filters
- Admin analytics: users, equipment, pending approvals, paid bookings and gross revenue
- Owner analytics: listed equipment, paid rentals and gross earnings
- Charts data for the last 6 months, grouped by month in Bangladesh time

### 8. 🧪 Strict Input Validation

- Allowed fields only, and every value is trimmed
- Name 3 to 100 characters, description 10 to 2000 characters, location 2 to 120 characters
- Category, rental type and condition must be one of the allowed values
- Price up to 10,000,000 and quantity from 0 to 1000
- Image must be a valid http or https URL
- Invalid ObjectIds and missing records return 400 and 404 instead of crashing
- Consistent error shape: `{ "message": "..." }`

### 9. ⚡ Indexed Queries and Bangladesh Time

- Indexes for equipment by status, owner and category, and for bookings by equipment, customer and owner
- "Today" is always computed in Asia/Dhaka, so servers running in UTC cannot shift the day

---

## 🗃️ Data Collections

| Collection | Purpose |
|---|---|
| `user`, `session` | Managed by Better Auth on the frontend |
| `equipment` | Listings with owner details and approval status |
| `bookings` | Rentals with dates, quantity, totals and payment state |
| `favorites` | One record per customer per saved item |
| `payments` | One record per verified Stripe session |

Unique indexes on `{ userId, equipmentId }` for favorites and on `sessionId` for payments guarantee no duplicates.

### Booking lifecycle

```
created  →  pending + unpaid  →  Stripe verified  →  confirmed + paid
```

---

## 📡 API Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/equipment` | Approved equipment. Query: `search`, `category`, `rentalType`, `minPrice`, `maxPrice`, `availability`, `sort`, `page`, `limit` |
| GET | `/equipment/featured` | 6 newest approved items |
| GET | `/equipment/categories` | Categories with live counts |
| GET | `/equipment/:id` | One approved item |

### Any signed-in user

| Method | Path | Description |
|---|---|---|
| GET | `/me` | Basic identity |
| GET | `/profile` | Full profile |
| PATCH | `/profile` | Update name, image, phone and address only |
| GET | `/equipment/:id/manage` | Full document for the owner or an admin |

### Customer

| Method | Path | Description |
|---|---|---|
| GET | `/favorites` | Saved equipment |
| GET | `/favorites/ids` | Saved equipment ids |
| POST | `/favorites` | Save equipment |
| DELETE | `/favorites/:equipmentId` | Remove a favorite |
| POST | `/bookings/checkout` | Validate, hold stock and create a Stripe session |
| GET | `/bookings/mine` | My bookings, paginated |
| POST | `/payments/checkout-verify` | Confirm a paid Stripe session |

### Owner

| Method | Path | Description |
|---|---|---|
| POST | `/equipment` | Create equipment (starts as `pending`) |
| GET | `/owner/equipment` | My equipment. Query: `status`, `search`, `page`, `limit` |
| GET | `/owner/bookings` | Paid bookings of my equipment |
| GET | `/owner/analytics` | My earnings and rentals |

### Owner or admin (own record, or admin)

| Method | Path | Description |
|---|---|---|
| PATCH | `/equipment/:id` | Update equipment |
| DELETE | `/equipment/:id` | Delete equipment (409 if it has active bookings) |

### Admin

| Method | Path | Description |
|---|---|---|
| GET | `/admin/equipment` | All equipment. Query: `status`, `search`, `page`, `limit` |
| PATCH | `/equipment/:id/status` | Approve, reject or set to pending |
| GET | `/admin/users` | All users. Query: `role`, `search`, `page`, `limit` |
| PATCH | `/admin/users/:id/role` | Change a user's role |
| PATCH | `/admin/users/:id/ban` | Suspend or restore a user |
| GET | `/admin/bookings` | All bookings. Query: `paymentStatus`, `bookingStatus` |
| GET | `/admin/analytics` | Platform statistics |

Errors use the shape `{ "message": "..." }` with status 400, 401, 403, 404, 409, 500, 502 or 503.

### Booking body example

```json
{
  "equipmentId": "665f1c2a9b1e4a0012ab34cd",
  "startDate": "2026-12-20",
  "endDate": "2026-12-23",
  "quantity": 1,
  "contactNumber": "01712345678",
  "deliveryAddress": "House 12, Road 5, Dhanmondi, Dhaka",
  "notes": "Please deliver in the morning"
}
```

---

## 📂 Project Structure

```
equipora-server/
├── index.js        # Express app, validation, auth and all routes
├── package.json
├── vercel.json     # Vercel deployment config
└── README.md
```

---

## ⚙️ Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- npm
- A MongoDB database, such as a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (the same one the frontend uses)
- A [Stripe](https://stripe.com/) account in test mode
- The [Equipora frontend](https://github.com/encodeshohan/equipora) for signing users in

### 1. Clone the repository

```bash
git clone https://github.com/encodeshohan/equipora-server.git
cd equipora-server
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root:

```env
MONGODB_URI=your_mongodb_connection_string
CLIENT_URL=http://localhost:3000
CLIENT_URLS=http://localhost:3000
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_CURRENCY=bdt
PORT=5000
```

| Name | Description |
|---|---|
| `MONGODB_URI` | MongoDB connection string for `equiporadb`. Must match the frontend's |
| `CLIENT_URL` | Deployed client origin, no trailing slash. Must match the client's `BETTER_AUTH_URL`. Also used for Stripe redirects |
| `CLIENT_URLS` | Comma-separated browser origins allowed by CORS |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` in test mode) |
| `STRIPE_CURRENCY` | Charge currency (defaults to `bdt`) |
| `STRIPE_BDT_PER_UNIT` | Only needed when the currency is not BDT: taka per 1 unit of that currency |
| `PORT` | Local port (defaults to 5000, ignored on Vercel) |

**Important:** never commit your `.env` file or expose your secrets publicly.

### 4. Run the server

```bash
npm run dev
```

The API runs at <http://localhost:5000>.

---

## 📜 Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the server with auto-restart on changes |
| `npm start` | Start the server in production mode |

---

## 🚀 Deployment (Vercel)

1. Import the repository as a new Vercel project.
2. Add `MONGODB_URI`, `CLIENT_URL`, `CLIENT_URLS` and `STRIPE_SECRET_KEY` in Project Settings > Environment Variables. Do not set `PORT`.
3. In MongoDB Atlas > Network Access, allow connections from Vercel. Vercel uses changing IP addresses, so `0.0.0.0/0` is needed.
4. Set `NEXT_PUBLIC_API_BASE_URL` on the client to this server's deployed URL.
5. Make sure `CLIENT_URL` matches the client's `BETTER_AUTH_URL` exactly, including `https://` and with no trailing slash. Otherwise every protected request returns 401.

---

## 📝 Notes

- Dates are compared as `YYYY-MM-DD` strings in Bangladesh time (Asia/Dhaka). A rental can start today.
- Revenue and earnings are gross amounts paid by customers, and analytics count paid bookings only.
- CORS allows only the origins in `CLIENT_URLS`, so Vercel preview deployments on other URLs cannot call the API.
- Bookings are not moved to `completed` automatically, so completed-rental counts stay at 0.

---

## 📌 Future Improvements

- ⏰ Scheduled job to mark bookings as completed after their end date
- 🪝 Stripe webhook to confirm payments without the success page
- 📧 Email notifications for bookings and approvals
- 🚦 Rate limiting on public routes
- ⭐ Reviews and ratings for equipment
- 🔎 Full-text search with a MongoDB text index
- 🧪 Automated API tests

---

## 👨‍💻 Author

**MD. SHOHANUR RAHMAN SHOHAN**

GitHub: [@encodeshohan](https://github.com/encodeshohan)

Built with ❤️ using Node.js, Express and MongoDB.