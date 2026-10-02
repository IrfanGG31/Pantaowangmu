-- Users table
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  timezone TEXT DEFAULT 'Asia/Jakarta',
  created_at DATETIME DEFAULT (datetime('now'))
);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
  amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 999999999),
  category TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Budgets table
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  month TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(user_id, category, month),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Reminder log table
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  reminder_date TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(user_id, reminder_date),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user_type ON transactions(user_id, type);
CREATE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets(user_id, month);
CREATE INDEX IF NOT EXISTS idx_reminder_log_user_date ON reminder_log(user_id, reminder_date);

-- Assistant memory: preferred nickname and facts the user asked the assistant to remember
CREATE TABLE IF NOT EXISTS user_profile (
  user_id TEXT PRIMARY KEY,
  nickname TEXT DEFAULT '',
  updated_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_facts_user ON user_facts(user_id);

-- One row per AI call, for quota and the admin dashboard (no message content stored)
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  error TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

-- Which users were active on which local date (for daily/weekly/monthly active users)
CREATE TABLE IF NOT EXISTS user_activity_daily (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_user_activity_date ON user_activity_daily(date);

-- Admin actions on users
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  details TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);

-- Savings goals the user shares with the assistant (e.g. "nikah 50jt Des 2027")
CREATE TABLE IF NOT EXISTS user_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target_amount INTEGER NOT NULL CHECK(target_amount > 0),
  saved_amount INTEGER NOT NULL DEFAULT 0 CHECK(saved_amount >= 0),
  target_date TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_goals_user ON user_goals(user_id);

-- Paid plans (trial limits come from env; "free" is what users get after their plan expires)
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER CHECK(price IS NULL OR price >= 0),
  period_days INTEGER NOT NULL DEFAULT 30 CHECK(period_days > 0),
  ai_daily_limit INTEGER NOT NULL DEFAULT 100 CHECK(ai_daily_limit >= 0),
  receipt_monthly_limit INTEGER NOT NULL DEFAULT 100 CHECK(receipt_monthly_limit >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO plans (id, name, price, period_days, ai_daily_limit, receipt_monthly_limit) VALUES ('pro', 'Pro', NULL, 30, 100, 100);

-- Activation codes sold manually (transfer/QRIS) or given as promos
CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  days INTEGER NOT NULL CHECK(days > 0),
  price INTEGER NOT NULL DEFAULT 0 CHECK(price >= 0),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at DATETIME,
  disabled INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(code, user_id)
);

-- Every plan activation (voucher or manual payment); the basis for revenue reports
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0 CHECK(amount >= 0),
  method TEXT NOT NULL CHECK(method IN ('voucher', 'manual')),
  reference TEXT,
  days INTEGER NOT NULL,
  period_end DATETIME,
  created_by TEXT,
  created_at DATETIME DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- Expiry reminders already sent (one per user, kind and expiry date)
CREATE TABLE IF NOT EXISTS subscription_notices (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, expires_at)
);

-- Admin-editable settings (e.g. payment instructions shown in /langganan)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT (datetime('now'))
);

-- Personal categories: custom ones, plus overrides of default ones (emoji, hidden from pickers)
CREATE TABLE IF NOT EXISTS user_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
  name TEXT NOT NULL,
  emoji TEXT,
  is_custom INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(user_id, type, name)
);

-- Words the user taught Panta ("kopken" → kopi); checked before the built-in keywords
CREATE TABLE IF NOT EXISTS category_keywords (
  user_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
  category TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, keyword)
);

-- Wallets / payment methods (optional: nothing changes for users without wallets)
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('cash', 'bank', 'ewallet', 'qris', 'credit', 'other')),
  opening_balance INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

-- Money moved between the user's own wallets (not income or spending)
CREATE TABLE IF NOT EXISTS wallet_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  from_wallet_id INTEGER NOT NULL,
  to_wallet_id INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 999999999),
  note TEXT DEFAULT '',
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_transfers_user ON wallet_transfers(user_id, created_at);

-- Monthly recurring bills / income (kos, Netflix, cicilan, gaji tetap), with the month last paid
CREATE TABLE IF NOT EXISTS recurring_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 999999999),
  type TEXT NOT NULL DEFAULT 'expense' CHECK(type IN ('income', 'expense')),
  category TEXT NOT NULL DEFAULT 'tagihan',
  day_of_month INTEGER NOT NULL CHECK(day_of_month BETWEEN 1 AND 31),
  wallet_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  last_paid_month TEXT,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recurring_bills_user ON recurring_bills(user_id);

-- One row per nudge sent (habit nudges, bill reminders), so each goes out once
CREATE TABLE IF NOT EXISTS nudge_log (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date, kind)
);

-- Debts and receivables (split bills, lending). A separate ledger: it never changes "Sisa saldo";
-- a split bill records only the user's own share as spending.
CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  person TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('owed_to_me', 'i_owe')),
  amount INTEGER NOT NULL CHECK(amount > 0 AND amount <= 999999999),
  note TEXT DEFAULT '',
  settled INTEGER NOT NULL DEFAULT 0,
  source_tx_id INTEGER,
  created_at DATETIME DEFAULT (datetime('now')),
  settled_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id, settled);

-- Personal challenges: no_spend (nothing in a category), limit (spend at most X), streak (log every day)
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('no_spend', 'limit', 'streak')),
  category TEXT,
  target_amount INTEGER,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'done', 'failed', 'cancelled')),
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_challenges_user ON challenges(user_id, status);

-- Needs users asked for that Panta/the bot can't meet yet, kept as product ideas. Summaries are anonymized;
-- the admin sees them grouped by topic with counts, never who asked.
CREATE TABLE IF NOT EXISTS feature_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('ai', 'unparsed')),
  topic TEXT NOT NULL,
  summary TEXT NOT NULL,
  clustered INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_topic ON feature_requests(topic);
CREATE INDEX IF NOT EXISTS idx_feature_requests_created ON feature_requests(created_at);

CREATE TABLE IF NOT EXISTS idea_topics (
  topic TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'planned', 'done', 'ignored')),
  note TEXT,
  updated_at DATETIME DEFAULT (datetime('now'))
);

-- Admin broadcasts to users (counts only; recipients are not stored)
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_email TEXT NOT NULL,
  segment TEXT NOT NULL,
  text TEXT NOT NULL,
  with_button INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('sending', 'done', 'interrupted', 'test')),
  created_at DATETIME DEFAULT (datetime('now')),
  finished_at DATETIME
);
