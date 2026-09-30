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
