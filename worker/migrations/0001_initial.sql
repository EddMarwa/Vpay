PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  account_disabled INTEGER NOT NULL DEFAULT 0 CHECK (account_disabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  session_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_active_idx ON sessions(expires_at, revoked_at);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'usage' CHECK (type IN ('usage', 'time')),
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE billing_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  plan_name TEXT,
  plan_type TEXT CHECK (plan_type IS NULL OR plan_type IN ('usage', 'time')),
  credits_remaining INTEGER NOT NULL DEFAULT 0 CHECK (credits_remaining >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  expires_at TEXT,
  entitled INTEGER NOT NULL DEFAULT 0 CHECK (entitled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  provider TEXT NOT NULL,
  provider_payment_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled', 'failed')),
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  invoice_url TEXT,
  coin TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX payments_user_status_idx ON payments(user_id, status, created_at);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE capture_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'ANY',
  url_contains TEXT,
  capture_request_headers INTEGER NOT NULL DEFAULT 0 CHECK (capture_request_headers IN (0, 1)),
  capture_request_body INTEGER NOT NULL DEFAULT 0 CHECK (capture_request_body IN (0, 1)),
  capture_response_headers INTEGER NOT NULL DEFAULT 0 CHECK (capture_response_headers IN (0, 1)),
  capture_response_body INTEGER NOT NULL DEFAULT 0 CHECK (capture_response_body IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE interceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER NOT NULL CHECK (status BETWEEN 100 AND 599),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX interceptions_user_created_idx ON interceptions(user_id, created_at);

CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES capture_rules(id) ON DELETE SET NULL,
  rule_name TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  request_headers_json TEXT,
  request_body TEXT,
  response_headers_json TEXT,
  response_body TEXT,
  captured_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX records_user_created_idx ON records(user_id, created_at);
