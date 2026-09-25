const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
};

const ok = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const fail = (message, status = 500, extra = {}) =>
  ok({ error: message, ...extra }, status);

let shopifyTokenCache = { value: null, expires: 0 };

async function getShopifyToken(env) {
  if (shopifyTokenCache.value && Date.now() < shopifyTokenCache.expires) {
    return shopifyTokenCache.value;
  }
  if (!env.SHOPIFY_SHOP || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify is not configured in Worker variables.");
  }

  const response = await fetch(
    `https://${env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET
      })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "Shopify authentication failed."
    );
  }

  shopifyTokenCache = {
    value: data.access_token,
    expires: Date.now() + Math.max(60, (Number(data.expires_in) || 86399) - 300) * 1000
  };
  return shopifyTokenCache.value;
}

async function shopifyGraphQL(env, query, variables = {}) {
  const token = await getShopifyToken(env);
  const response = await fetch(
    `https://${env.SHOPIFY_SHOP}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.errors?.[0]?.message || "Shopify API request failed.");
  }
  if (data.errors?.length) {
    throw new Error(data.errors[0].message || "Shopify GraphQL error.");
  }
  return data.data;
}

const PRODUCTS_QUERY = `query Products($after: String) {
  products(first: 100, after: $after, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      description
      productType
      tags
      images(first: 6) { nodes { url altText } }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          price
          availableForSale
          selectedOptions { name value }
          image { url altText }
        }
      }
    }
  }
}`;

async function getProducts(env, request) {
  const url = new URL(request.url);
  const after = url.searchParams.get("after") || null;
  const data = await shopifyGraphQL(env, PRODUCTS_QUERY, { after });
  const p = data.products;
  return ok({
    products: (p?.nodes || []).map(x => ({
      id: x.id,
      title: x.title,
      handle: x.handle,
      description: x.description,
      productType: x.productType,
      tags: x.tags || [],
      images: x.images?.nodes || [],
      variants: x.variants?.nodes || []
    })),
    pageInfo: p?.pageInfo || { hasNextPage: false, endCursor: null }
  });
}

const VARIANTS_QUERY = `query Variants($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      title
      sku
      price
      availableForSale
      product { id title }
    }
  }
}`;

function cashfreeBase(env) {
  return env.CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

async function createCashfreeOrder(env, order, origin) {
  if (!env.CASHFREE_CLIENT_ID || !env.CASHFREE_CLIENT_SECRET) {
    throw new Error("Cashfree is not configured in Worker variables.");
  }

  const response = await fetch(`${cashfreeBase(env)}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-id": env.CASHFREE_CLIENT_ID,
      "x-client-secret": env.CASHFREE_CLIENT_SECRET,
      "x-api-version": env.CASHFREE_API_VERSION || "2025-01-01"
    },
    body: JSON.stringify({
      order_id: order.id,
      order_amount: order.amount,
      order_currency: "INR",
      customer_details: {
        customer_id: order.id,
        customer_name: order.customer.name,
        customer_email: order.customer.email,
        customer_phone: order.customer.phone
      },
      order_meta: {
        return_url: `${origin}/?payment=return&order_id=${encodeURIComponent(order.id)}`,
        notify_url: `${origin}/api/cashfree-webhook`
      },
      order_note: "404 Society online order"
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.payment_session_id) {
    throw new Error(data.message || data.error || "Cashfree order creation failed.");
  }
  return data;
}

async function createPayment(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const customer = body.customer || {};
  const items = Array.isArray(body.items) ? body.items : [];

  if (!customer.name || !customer.email || !customer.phone ||
      !customer.address || !customer.city || !customer.state || !customer.pincode) {
    return fail("Please complete all checkout fields.", 400);
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) {
    return fail("Enter a valid email address.", 400);
  }

  if (!/^[0-9]{10}$/.test(String(customer.phone).replace(/\D/g, ""))) {
    return fail("Enter a valid 10-digit mobile number.", 400);
  }

  if (!/^[0-9]{6}$/.test(String(customer.pincode))) {
    return fail("Enter a valid 6-digit pincode.", 400);
  }

  const clean = items
    .map(x => ({
      variantId: String(x.variantId || ""),
      quantity: Math.max(1, Math.min(20, Number(x.quantity) || 1))
    }))
    .filter(x => x.variantId);

  if (!clean.length) return fail("Your bag is empty.", 400);

  const data = await shopifyGraphQL(env, VARIANTS_QUERY, {
    ids: [...new Set(clean.map(x => x.variantId))]
  });

  const variants = new Map(
    (data.nodes || []).filter(Boolean).map(v => [v.id, v])
  );

  let amount = 0;
  const safeItems = [];

  for (const item of clean) {
    const v = variants.get(item.variantId);
    if (!v) throw new Error("A selected Shopify variant was not found.");
    if (v.availableForSale === false) {
      throw new Error(`${v.product?.title || "This product"} is unavailable.`);
    }

    const price = Number(v.price);
    if (!Number.isFinite(price)) throw new Error("Invalid Shopify price.");

    amount += price * item.quantity;
    safeItems.push({
      variantId: v.id,
      sku: v.sku || null,
      name: v.product?.title || v.title,
      variantTitle: v.title || "Default",
      quantity: item.quantity,
      unitPrice: price
    });
  }

  amount = Number(amount.toFixed(2));
  const id = `404_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const cashfree = await createCashfreeOrder(
    env,
    { id, amount, customer },
    origin
  );

  if (env.DB) {
    await env.DB.prepare(`
      INSERT INTO orders
      (id,cashfree_order_id,customer_name,customer_email,customer_phone,
       address_line,city,state,pincode,amount,currency,items_json,status,
       fulfillment_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      id,
      cashfree.order_id || id,
      customer.name,
      customer.email,
      String(customer.phone).replace(/\D/g, ""),
      customer.address,
      customer.city,
      customer.state,
      String(customer.pincode),
      Math.round(amount * 100),
      "INR",
      JSON.stringify(safeItems),
      "payment_pending",
      "pending",
      now,
      now
    ).run();
  }

  return ok({
    order_id: id,
    payment_session_id: cashfree.payment_session_id,
    mode: env.CASHFREE_ENV === "production" ? "production" : "sandbox"
  });
}

async function getCashfreeOrder(env, orderId) {
  const response = await fetch(`${cashfreeBase(env)}/orders/${encodeURIComponent(orderId)}`, {
    headers: {
      "x-client-id": env.CASHFREE_CLIENT_ID,
      "x-client-secret": env.CASHFREE_CLIENT_SECRET,
      "x-api-version": env.CASHFREE_API_VERSION || "2025-01-01"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Unable to check payment status.");
  return data;
}

async function paymentStatus(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("order_id");
  if (!id) return fail("order_id is required.", 400);

  const data = await getCashfreeOrder(env, id);
  return ok({
    order_id: id,
    order_status: data.order_status || null,
    payment_status: data.payment_status || null
  });
}

async function verifyCashfreeWebhook(request, env, rawBody) {
  const signature = request.headers.get("x-webhook-signature");
  const timestamp = request.headers.get("x-webhook-timestamp");
  if (!signature || !timestamp || !env.CASHFREE_CLIENT_SECRET) return false;

  const message = `${timestamp}${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CASHFREE_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(signed)));

  return base64 === signature;
}

async function cashfreeWebhook(request, env) {
  const raw = await request.text();

  if (!(await verifyCashfreeWebhook(request, env, raw))) {
    return fail("Invalid Cashfree webhook signature.", 401);
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return fail("Invalid webhook JSON.", 400); }

  const orderId = payload?.data?.order?.order_id || payload?.order_id;
  const paymentStatus =
    payload?.data?.payment?.payment_status ||
    payload?.payment_status ||
    payload?.data?.order?.order_status ||
    payload?.order_status;

  if (!orderId) return ok({ ok: true });

  if (env.DB) {
    const existing = await env.DB.prepare(
      `SELECT id,status FROM orders WHERE id=? OR cashfree_order_id=? LIMIT 1`
    ).bind(orderId, orderId).first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE orders SET status=?,updated_at=? WHERE id=? OR cashfree_order_id=?`
      ).bind(
        paymentStatus || "webhook_received",
        new Date().toISOString(),
        orderId,
        orderId
      ).run();
    }
  }

  return ok({ ok: true });
}

async function health(env) {
  return ok({
    ok: true,
    service: "404 Society",
    shopify: Boolean(env.SHOPIFY_SHOP && env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET),
    cashfree: Boolean(env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET),
    database: Boolean(env.DB)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type"
          }
        });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return health(env);
      }

      if (url.pathname === "/api/products" && request.method === "GET") {
        return getProducts(env, request);
      }

      if (url.pathname === "/api/create-payment" && request.method === "POST") {
        return createPayment(request, env, url.origin);
      }

      if (url.pathname === "/api/payment-status" && request.method === "GET") {
        return paymentStatus(request, env);
      }

      if (url.pathname === "/api/cashfree-webhook" && request.method === "POST") {
        return cashfreeWebhook(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return fail(error?.message || "Server error.", 500);
    }
  }
};
