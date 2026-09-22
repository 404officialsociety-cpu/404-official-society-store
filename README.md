# 404 Society — Store

Bold, colorful streetwear storefront for 404 Society.

## Stack
- Cloudflare Workers + Static Assets
- Vanilla HTML/CSS/JS (no build step)
- Optional Cloudflare D1 for order records
- Cashfree hosted checkout
- Qikink fulfillment adapter (credentials stay server-side)

## Security
**Never put Cashfree secret keys or Qikink API credentials in this repository or frontend JavaScript.**
Use Cloudflare Worker secrets/environment variables.

## Demo mode
The storefront works immediately with demo products. Payment creation returns a clear configuration message until Cashfree secrets are configured.

## Deploy
1. Create a Cloudflare Worker.
2. Install Wrangler locally.
3. Set the Worker secrets:
   - `CASHFREE_CLIENT_ID`
   - `CASHFREE_CLIENT_SECRET`
   - `CASHFREE_API_VERSION` (optional; set to the version required by your Cashfree account)
   - `QIKINK_API_BASE` (optional)
   - `QIKINK_API_KEY` (optional)
   - `QIKINK_API_SECRET` (optional)
4. Create a D1 database and update `wrangler.toml` with its database ID.
5. Run the migration:
   `wrangler d1 migrations apply DB --remote`
6. Deploy:
   `wrangler deploy`

Cashfree's hosted checkout flow creates the order on the backend and uses the returned payment session ID on the client. See the official Cashfree developer docs for the current API version and SDK details.

Qikink's API/order fields can vary by account/integration. The server includes an isolated adapter so credentials and mapping stay off the client; fill the adapter mapping from your Qikink dashboard/API documentation before enabling live fulfillment.
