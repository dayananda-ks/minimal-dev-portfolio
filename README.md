# minimal-dev-portfolio

Personal portfolio with a Razorpay-gated resume download flow.

## What changed

- The homepage still uses the existing static HTML/CSS portfolio.
- Resume access now goes through Razorpay checkout for ₹10.
- Payment verification happens on the backend only.
- Resume delivery is protected behind a signed access token and backend streaming endpoint.

## Project layout

- `index.html`: existing portfolio UI with the payment-gated resume action.
- `config.js`: public frontend config, mainly the backend API base URL.
- `resume.pdf`: legacy local copy of the resume file; do not publish this through the frontend.
- `backend/`: Express + Razorpay + SQLite payment service.

## Frontend flow

1. Visitor clicks `Download Resume`.
2. Frontend requests `POST /api/payments/create-order`.
3. Backend creates a ₹10 Razorpay order.
4. Razorpay Checkout opens.
5. On success, frontend sends the payment response to `POST /api/payments/verify`.
6. Backend verifies the Razorpay signature and returns a signed access token.
7. Frontend uses that token to fetch the protected resume from `GET /api/resume/access`.

## Backend setup

1. Install backend dependencies:

```bash
cd backend
npm install
```

2. Copy `.env.example` to `.env` and fill in the values. Set `FRONTEND_ORIGINS` to the exact origin serving the portfolio and `FRONTEND_RETURN_URL` to one of those origins. Configure the matching Razorpay callback URL (`/api/payments/callback`) on the public backend domain and allowlist it in Razorpay.

3. Make sure `RESUME_FILE_PATH` points to the private PDF on the backend host.

4. Start the server:

```bash
npm run start
```

## Frontend config

Update `config.js` so `apiBaseUrl` points to your backend deployment. The frontend only needs the public Razorpay key id from the create-order response.

## Razorpay test mode to live mode

1. Use test credentials in backend `.env` and keep the frontend pointed at the test backend.
2. Verify the flow end-to-end with a test payment.
3. Swap `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to live credentials on the backend.
4. Update `config.js` to point to the live backend URL.
5. Confirm the backend still validates amount, currency, signature, and access expiry before allowing the resume download.

## Notes

- Do not expose the resume PDF as a public static asset.
- Do not commit backend secrets or `.env` files.
- GitHub Pages now deploys only the public frontend files.
