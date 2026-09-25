CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  cashfree_order_id TEXT,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address_line TEXT,
  city TEXT,
  state TEXT,
  pincode TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  fulfillment_status TEXT DEFAULT 'pending',
  qikink_order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_cashfree_order_id
ON orders(cashfree_order_id);
