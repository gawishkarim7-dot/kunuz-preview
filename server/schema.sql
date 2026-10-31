CREATE TABLE IF NOT EXISTS orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  token_hash CHAR(64) NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ar', 'en')),
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  shipping_method TEXT NOT NULL,
  customer JSONB NOT NULL,
  totals JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  product_type TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0),
  selection JSONB NOT NULL DEFAULT '{}'::jsonb,
  configuration JSONB
);

CREATE TABLE IF NOT EXISTS quotes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  product_id INTEGER,
  customer_name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotes_created_at_idx ON quotes (created_at DESC);
CREATE INDEX IF NOT EXISTS quotes_status_idx ON quotes (status, created_at DESC);

CREATE TABLE IF NOT EXISTS quote_files (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quote_id BIGINT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  contents BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
