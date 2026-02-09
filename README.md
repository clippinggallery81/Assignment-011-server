# AssetVerse Backend Server

Corporate asset management API with role-based access, JWT authentication, and Stripe payments.

## Features

- JWT-protected APIs with HR-only middleware
- Asset inventory, requests, approvals, returns
- Employee affiliations and team management
- Stripe checkout for package upgrades
- Payment history tracking
- MongoDB collections with indexes

## Tech Stack

- Node.js, Express
- MongoDB
- JWT (jsonwebtoken)
- Stripe

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file:

```env
DB_USERS=your_mongodb_username
DB_PASS=your_mongodb_password
PORT=3000
JWT_SECRET=your_jwt_secret
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_SUCCESS_URL=http://localhost:5173/dashboard/upgrade?success=1&session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=http://localhost:5173/dashboard/upgrade?canceled=1
STRIPE_PRICE_BASIC=price_basic_id
STRIPE_PRICE_STANDARD=price_standard_id
STRIPE_PRICE_PREMIUM=price_premium_id
```

Start server:

```bash
node index.js
```

## Key Endpoints

Auth:
- `POST /jwt`

Users:
- `GET /user/:email`
- `GET /users-by-emails`
- `POST /users`
- `PUT /users/:email`

Assets:
- `POST /assets`
- `GET /assets?email=...&page=1&limit=10`
- `GET /available-assets?companyName=...`
- `GET /assigned-assets?email=...`
- `PUT /assets/:assetId`
- `DELETE /assets/:assetId`

Requests:
- `GET /requests?hrEmail=...` or `?employeeEmail=...`
- `POST /requests`
- `PATCH /requests/:requestId`

Affiliations & Team:
- `GET /affiliations?employeeEmail=...` or `?companyName=...`
- `PATCH /affiliations/remove`
- `GET /company-assignments?companyName=...`
- `POST /assign-asset`

Packages & Payments:
- `GET /packages`
- `POST /create-checkout-session`
- `POST /confirm-payment`
- `GET /payments?hrEmail=...`

## Notes

- Packages are seeded on startup if empty.
- Stripe keys are required for checkout.
- JWT is required for protected routes.
