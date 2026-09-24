const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

let shopifyTokenCache = {
  value: null,
  expires: 0,
};

async function shopifyToken(env) {
  if (
    shopifyTokenCache.value &&
    Date.now() < shopifyTokenCache.expires
  ) {
    return shopifyTokenCache.value;
  }

  if (
    !env.SHOPIFY_SHOP ||
    !env.SHOPIFY_CLIENT_ID ||
    !env.SHOPIFY_CLIENT_SECRET
  ) {
    throw new Error("Shopify is not configured");
  }

  const response = await fetch(
    `https://${env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SHOPIFY_CLIENT_ID,
        client_secret: env.SHOPIFY_CLIENT_SECRET,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Shopify authentication failed (${response.status})`
    );
  }

  shopifyTokenCache = {
    value: data.access_token,
    expires:
      Date.now() +
      Math.max(60, (Number(data.expires_in) || 86399) - 300) * 1000,
  };

  return shopifyTokenCache.value;
}

async function shopifyGraphQL(env, query, variables = {}) {
  const accessToken = await shopifyToken(env);

  const response = await fetch(
    `https://${env.SHOPIFY_SHOP}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Shopify API HTTP error ${response.status}: ${
        data.errors?.[0]?.message || "Unknown error"
      }`
    );
  }

  if (data.errors?.length) {
    throw new Error(
      data.errors
        .map((error) => error.message)
        .join("; ")
    );
  }

  return data.data;
}

const PRODUCTS_QUERY = `
query {
  products(first: 100, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id
      title
      handle
      productType
      tags

      images(first: 5) {
        nodes {
          url
          altText
        }
      }

      variants(first: 100) {
        nodes {
          id
          title
          sku
          price
          availableForSale

          selectedOptions {
            name
            value
          }

          image {
            url
          }
        }
      }
    }
  }
}
`;

const VARIANT_QUERY = `
query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      title
      sku
      price
      availableForSale

      product {
        id
        title
        productType
        tags

        images(first: 1) {
          nodes {
            url
            altText
          }
        }
      }
    }
  }
}
`;

async function getProducts(env) {
  const data = await shopifyGraphQL(
    env,
    PRODUCTS_QUERY
  );

  const products =
    data.products?.nodes?.map((product) => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      productType: product.productType,
      tags: product.tags || [],
      images: product.images?.nodes || [],
      variants: product.variants?.nodes || [],
    })) || [];

  return json({
    products,
  });
}

function cashfreeBase(env) {
  return env.CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

async function createCashfreeOrder(
  env,
  order,
  origin
) {
  if (
    !env.CASHFREE_CLIENT_ID ||
    !env.CASHFREE_CLIENT_SECRET
  ) {
    throw new Error("Cashfree is not configured");
  }

  const response = await fetch(
    `${cashfreeBase(env)}/orders`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-id": env.CASHFREE_CLIENT_ID,
        "x-client-secret": env.CASHFREE_CLIENT_SECRET,
        "x-api-version":
          env.CASHFREE_API_VERSION || "2025-01-01",
      },
      body: JSON.stringify({
        order_id: order.id,
        order_amount: order.amount,
        order_currency: "INR",

        customer_details: {
          customer_id: order.id,
          customer_name: order.customer.name,
          customer_email: order.customer.email,
          customer_phone: order.customer.phone,
        },

        order_meta: {
          return_url:
            `${origin}/?payment=return&order_id=` +
            encodeURIComponent(order.id),

          notify_url:
            `${origin}/api/cashfree-webhook`,
        },
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
        `Cashfree order creation failed (${response.status})`
    );
  }

  return data;
}

async function createPayment(req, env, origin) {
  const body = await req.json().catch(() => ({}));

  const customer = body.customer || {};
  const items = Array.isArray(body.items)
    ? body.items
    : [];

  if (
    !customer.name ||
    !customer.email ||
    !customer.phone ||
    !items.length
  ) {
    return json(
      {
        error:
          "Name, email, phone and items are required",
      },
      400
    );
  }

  const cleanItems = items
    .map((item) => ({
      variantId: String(item.variantId || ""),
      quantity: Math.max(
        1,
        Math.min(20, Number(item.quantity) || 1)
      ),
    }))
    .filter((item) => item.variantId);

  if (!cleanItems.length) {
    return json(
      {
        error: "No valid products selected",
      },
      400
    );
  }

  const data = await shopifyGraphQL(
    env,
    VARIANT_QUERY,
    {
      ids: cleanItems.map(
        (item) => item.variantId
      ),
    }
  );

  const variantMap = new Map(
    (data.nodes || [])
      .filter(Boolean)
      .map((variant) => [
        variant.id,
        variant,
      ])
  );

  let amount = 0;
  const safeItems = [];

  for (const item of cleanItems) {
    const variant = variantMap.get(
      item.variantId
    );

    if (!variant) {
      throw new Error(
        "Selected Shopify variant was not found"
      );
    }

    if (variant.availableForSale === false) {
      throw new Error(
        `${variant.product?.title || "Product"} is unavailable`
      );
    }

    const price = Number(variant.price);

    if (!Number.isFinite(price)) {
      throw new Error(
        "Invalid Shopify price"
      );
    }

    amount += price * item.quantity;

    safeItems.push({
      variantId: variant.id,
      sku: variant.sku || null,
      name:
        variant.product?.title ||
        variant.title,
      variantTitle: variant.title,
      quantity: item.quantity,
      unitPrice: price,
    });
  }

  const orderId =
    `404_${Date.now()}_` +
    crypto.randomUUID().slice(0, 8);

  const now =
    new Date().toISOString();

  const cashfree =
    await createCashfreeOrder(
      env,
      {
        id: orderId,
        customer,
        amount,
        items: safeItems,
      },
      origin
    );

  if (env.DB) {
    await env.DB.prepare(
      `
      INSERT INTO orders (
        id,
        cashfree_order_id,
        customer_name,
        customer_email,
        customer_phone,
        amount,
        currency,
        items_json,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        orderId,
        cashfree.order_id || null,
        customer.name,
        customer.email,
        customer.phone,
        Math.round(amount * 100),
        "INR",
        JSON.stringify(safeItems),
        "created",
        now,
        now
      )
      .run();
  }

  return json({
    payment_session_id:
      cashfree.payment_session_id,

    mode:
      env.CASHFREE_ENV === "production"
        ? "production"
        : "sandbox",

    order_id: orderId,
  });
}

async function cashfreeWebhook(
  req,
  env
) {
  const body = await req.text();

  let data = {};

  try {
    data = JSON.parse(body);
  } catch {}

  if (env.DB && data.order_id) {
    await env.DB.prepare(
      `
      UPDATE orders
      SET status = ?, updated_at = ?
      WHERE id = ?
         OR cashfree_order_id = ?
      `
    )
      .bind(
        data.order_status ||
          data.payment_status ||
          "webhook_received",

        new Date().toISOString(),

        data.order_id,
        data.order_id
      )
      .run();
  }

  return json({
    ok: true,
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    try {
      if (
        url.pathname === "/api/products" &&
        req.method === "GET"
      ) {
        return getProducts(env);
      }

      if (
        url.pathname === "/api/create-payment" &&
        req.method === "POST"
      ) {
        return createPayment(
          req,
          env,
          url.origin
        );
      }

      if (
        url.pathname === "/api/cashfree-webhook" &&
        req.method === "POST"
      ) {
        return cashfreeWebhook(req, env);
      }

      return env.ASSETS.fetch(req);

    } catch (error) {
      console.error(error);

      return json(
        {
          error:
            error?.message ||
            "Server error",
        },
        500
      );
    }
  },
};
