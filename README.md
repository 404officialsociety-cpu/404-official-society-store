# 404 Society — 3D Shopify + Cashfree Store

This build is designed for Cloudflare Workers + Static Assets.

## Architecture

Shopify Admin
→ Shopify Admin GraphQL API 2026-07
→ Cloudflare Worker `/api/products`
→ 404 Society 3D storefront

Checkout:
Storefront → Worker verifies live Shopify variant prices → Cashfree order → Cashfree Checkout → payment return + webhook

Cloudflare D1 stores the order record when the `DB` binding is present.

## Required Worker variables/secrets

Keep all secret values in Cloudflare. Never put them in GitHub or frontend JavaScript.

Variables/secrets:
- `SHOPIFY_SHOP` = your Shopify shop handle, e.g. `py072z-6w`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET` (secret)
- `CASHFREE_ENV` = `sandbox` while testing, `production` for live payments
- `CASHFREE_CLIENT_ID`
- `CASHFREE_CLIENT_SECRET` (secret)
- `CASHFREE_API_VERSION` = your approved Cashfree API version
- `DB` = D1 database binding to `404-society-db`

## Cloudflare build settings

Root directory: `/`

Build command: leave EMPTY

Deploy command:
`npx wrangler deploy`

The Worker name in `wrangler.toml` is:
`404-official-society-store`

If the existing Worker already has that name, keep it. Do not create a second Worker.

## D1

Apply `migrations/0001_init.sql` to the existing `404-society-db` if the table has not already been created.

If the dashboard already has the D1 binding, its variable name must be exactly:
`DB`

## Shopify

The Shopify app needs `read_products` for catalog retrieval. The storefront does not expose the Shopify secret.

The Worker uses:
`https://YOURSHOP.myshopify.com/admin/api/2026-07/graphql.json`

Products are loaded with cursor pagination so the storefront can load more than the first 100 products.

## Cashfree

Use Cashfree sandbox first. The browser receives only a `payment_session_id`; the Cashfree client/secret stays in the Worker.

Cashfree webhook URL:
`https://YOUR-WORKER-URL/api/cashfree-webhook`

Whitelist the exact production storefront/Worker URL in Cashfree before live checkout.

The webhook handler verifies the `x-webhook-signature` using the raw body and timestamp.

## Important before live launch

1. Test Shopify product listing.
2. Test Cashfree sandbox payment.
3. Verify the webhook reaches `/api/cashfree-webhook`.
4. Confirm D1 order rows are created/updated.
5. Only then switch Cashfree to production and update its whitelist.

## Qikink

Qikink can integrate with Shopify and can automatically sync Shopify orders when its Shopify integration is configured. This build does not invent or expose Qikink credentials in frontend code. Configure Qikink's Shopify integration separately if you want Qikink to receive and fulfill Shopify orders automatically.
